// Seeds the development stack: bootstrap a tenant that trusts dev/idp.mjs,
// create each arena's tick and input streams, give each arena a play and a
// watch role, and write the broker's and the sim's tokens to the state
// directory. Safe to run again: existing objects are kept.
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";

const env = (name, fallback) => process.env[name] || fallback;

const CONTROL_PLANE = env("ARENA_FELIX_CONTROL_PLANE", "http://controlplane:8443");
const BOOTSTRAP = env("ARENA_FELIX_BOOTSTRAP", "http://controlplane:9095");
const BOOTSTRAP_TOKEN = env("ARENA_FELIX_BOOTSTRAP_TOKEN", "dev-bootstrap");
const IDP = env("ARENA_IDP", "http://idp:9400");
const STATE = env("ARENA_STATE_DIR", "/state");
const TENANT = env("ARENA_TENANT", "arena");
const NAMESPACE = env("ARENA_NAMESPACE", "default");
const ARENAS = env("ARENA_ARENAS", "alpha bravo").split(/[\s,]+/).filter(Boolean);
// Who may play in every arena. Anyone else signed in may watch.
const PLAYERS = env("ARENA_PLAYERS", "ana,ben").split(",").filter(Boolean);
const AUDIENCE = "felix-arena";
const RETENTION_SECONDS = 7 * 24 * 60 * 60;
// Felix only promotes a replica it knows holds every acknowledged record when
// the commit waited for a majority, so ticks are `Quorum` once replicated.
const REPLICAS = Number(env("ARENA_REPLICAS", "1"));

async function request(method, url, { token, headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status === 409) {
    console.log(`  ${method} ${url}: already exists`);
    return null;
  }
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const { issuer } = await request("GET", `${IDP}/.well-known/openid-configuration`);
// Felix keys RBAC on sha256(issuer|subject), not on the subject itself.
const principal = (subject) => createHash("sha256").update(`${issuer}|${subject}`).digest("hex");

async function exchange(subject, body) {
  const { id_token } = await request("GET", `${IDP}/token?sub=${subject}&aud=${AUDIENCE}`);
  const url = `${CONTROL_PLANE}/v1/tenants/${TENANT}/token/exchange`;
  return (await request("POST", url, { token: id_token, body })).felix_token;
}

const object = (kind, name) => `${kind}:${TENANT}/${NAMESPACE}/${name}`;

console.log(`bootstrap tenant ${TENANT}`);
await request("POST", `${BOOTSTRAP}/internal/bootstrap/tenants/${TENANT}/initialize`, {
  headers: { "x-felix-bootstrap-token": BOOTSTRAP_TOKEN },
  body: {
    display_name: "Felix Arena",
    idp_issuers: [
      {
        issuer,
        audiences: [AUDIENCE],
        jwks_url: `${IDP}/jwks.json`,
        claim_mappings: { subject_claim: "sub" },
      },
    ],
    initial_admin_principals: [principal("arena-admin")],
    policies: [
      { subject: "role:admin", object: object("stream", "*"), action: "stream.manage" },
      { subject: "role:admin", object: object("cache", "*"), action: "cache.manage" },
      { subject: "role:broker", object: "cluster:*", action: "node.view" },
      { subject: "role:broker", object: "cluster:*", action: "node.manage" },
    ],
    groupings: [
      { user: principal("arena-admin"), role: "role:admin" },
      { user: principal("arena-broker"), role: "role:broker" },
      { user: principal("arena-sim"), role: "role:sim" },
    ],
  },
});

const admin = await exchange("arena-admin", { audience: "felix-controlplane" });
console.log(`namespace ${NAMESPACE}`);
await request("POST", `${CONTROL_PLANE}/v1/tenants/${TENANT}/namespaces`, {
  token: admin,
  body: { namespace: NAMESPACE, display_name: NAMESPACE },
});

const grant = (subject, kind, name, action) =>
  request("POST", `${CONTROL_PLANE}/v1/tenants/${TENANT}/rbac/policies`, {
    token: admin,
    body: { subject, object: object(kind, name), action },
  });

for (const arena of ARENAS) {
  const ticks = `arena.ticks.${arena}`;
  const input = `arena.input.${arena}`;
  for (const [stream, durable] of [
    [ticks, true],
    [input, false],
  ]) {
    console.log(`stream ${stream}`);
    await request("POST", `${CONTROL_PLANE}/v1/tenants/${TENANT}/namespaces/${NAMESPACE}/streams`, {
      token: admin,
      body: {
        stream,
        kind: "Stream",
        shards: 1,
        replication_factor: REPLICAS,
        retention: { max_age_seconds: durable ? RETENTION_SECONDS : null, max_size_bytes: null },
        consistency: durable && REPLICAS > 1 ? "Quorum" : "Leader",
        delivery: durable ? "AtLeastOnce" : "AtMostOnce",
        durable,
      },
    });
  }
  // A commit needs publish on the tick stream, and a state read subscribe.
  // Only the sim may publish ticks.
  await grant("role:sim", "stream", ticks, "stream.publish");
  await grant("role:sim", "stream", ticks, "stream.subscribe");
  await grant("role:sim", "stream", input, "stream.subscribe");
  // Exactly these actions: token exchange narrows by every action on every
  // resource a role holds (felix#968).
  const play = `role:arena-${arena}-play`;
  const watch = `role:arena-${arena}-watch`;
  await grant(play, "stream", input, "stream.publish");
  await grant(play, "stream", ticks, "stream.subscribe");
  await grant(watch, "stream", ticks, "stream.subscribe");
  console.log(`${play} for ${PLAYERS.join(", ") || "nobody"}`);
  for (const name of PLAYERS) {
    await request("POST", `${CONTROL_PLANE}/v1/tenants/${TENANT}/rbac/groupings`, {
      token: admin,
      body: { user: principal(name), role: play },
    });
  }
}

// The broker runs as uid 65532 and writes its certificate here too.
await mkdir(STATE, { recursive: true });
await chmod(STATE, 0o777).catch(() => {});
const broker = await exchange("arena-broker", { audience: "felix-controlplane" });
await writeFile(`${STATE}/node.token`, broker, { mode: 0o644 });
const sim = await exchange("arena-sim", { requested: ["stream.publish", "stream.subscribe"] });
await writeFile(`${STATE}/sim.token`, sim, { mode: 0o644 });
console.log(`wrote node.token and sim.token to ${STATE}`);

// up.sh waits for this before it calls the stack ready.
await writeFile(`${STATE}/seeded`, "");
