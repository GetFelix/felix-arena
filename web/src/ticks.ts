// A development page: follow one arena's tick stream through the gateway and
// show each tick's offset and number as it arrives. `?arena=` picks the
// arena and `?as=` the dev IdP user to sign in as.
import { Gateway, type EventFrame } from './gateway';
import { palette } from './palette';
import { parseTickHeader } from './tick';

const params = new URLSearchParams(location.search);
const arena = params.get('arena') ?? 'alpha';
const user = params.get('as') ?? 'cleo';
const GATEWAY = params.get('gateway') ?? 'ws://127.0.0.1:8787/ws';
const IDP = params.get('idp') ?? 'http://127.0.0.1:9400';
const RECENT = 15;

for (const [name, colour] of Object.entries(palette)) {
  document.documentElement.style.setProperty(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, colour);
}

const element = (id: string) => document.getElementById(id)!;
element('arena').textContent = arena;
const status = element('status');

function show(text: string, kind: '' | 'live' | 'down') {
  status.textContent = text;
  status.className = `status ${kind}`;
}

let lastOffset: number | null = null;
let dropped = 0;
const arrivals: number[] = [];

function onTick(frame: EventFrame) {
  const header = parseTickHeader(frame.payload);
  if (!header || frame.offset === null) return;
  if (lastOffset !== null) dropped += Math.max(0, frame.offset - lastOffset - 1 - frame.skippedBefore);
  lastOffset = frame.offset;
  const now = performance.now();
  arrivals.push(now);
  while (arrivals[0]! < now - 1000) arrivals.shift();

  element('offset').textContent = String(frame.offset);
  element('tick').textContent = String(header.tick);
  element('epoch').textContent = String(header.epoch);
  element('rate').textContent = String(arrivals.length);
  element('dropped').textContent = String(dropped);
  const row = document.createElement('tr');
  for (const cell of [frame.offset, header.tick, header.keyframe ? 'yes' : '']) {
    row.append(Object.assign(document.createElement('td'), { textContent: String(cell) }));
  }
  const recent = element('recent');
  recent.prepend(row);
  while (recent.childElementCount > RECENT) recent.lastElementChild!.remove();
}

async function main() {
  // The dev IdP mints an ID token for anyone; a real page signs in with PKCE.
  const answer = await fetch(`${IDP}/token?sub=${encodeURIComponent(user)}&aud=felix-arena`);
  const { id_token: token } = (await answer.json()) as { id_token: string };
  const gateway = await Gateway.connect(GATEWAY, arena, token);
  gateway.onError = (err) => show(`${err.code}: ${err.message}`, 'down');
  await gateway.subscribe('ticks', 'live', 'live', onTick);
  show(`live as ${user}`, 'live');
}

main().catch((err: unknown) => show(String(err), 'down'));
