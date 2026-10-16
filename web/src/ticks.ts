// A development page: follow one arena's tick stream through the gateway, show
// each tick's offset and number as it arrives, and the p50 and p99 of each leg
// of its trip from the sim. `?arena=` picks the
// arena and `?as=` the dev IdP user to sign in as.
import { Gateway, type EventFrame } from './gateway';
import { LEGS, Legs } from './legs';
import { setCssColours } from './palette';
import { decodeTick, loadCore, type Tick } from './core';

const params = new URLSearchParams(location.search);
const arena = params.get('arena') ?? 'alpha';
const user = params.get('as') ?? 'cleo';
const GATEWAY = params.get('gateway') ?? 'ws://127.0.0.1:8787/ws';
const IDP = params.get('idp') ?? 'http://127.0.0.1:9400';
const RECENT = 15;

setCssColours();

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
const legs = new Legs();

function onTick(frame: EventFrame) {
  let tick: Tick;
  try {
    tick = decodeTick(frame.payload);
  } catch {
    return;
  }
  if (frame.offset === null) return;
  if (lastOffset !== null) dropped += Math.max(0, frame.offset - lastOffset - 1 - frame.skippedBefore);
  lastOffset = frame.offset;
  if (tick.timing) legs.add(frame, tick.timing);
  const now = performance.now();
  arrivals.push(now);
  while (arrivals[0]! < now - 1000) arrivals.shift();

  element('offset').textContent = String(frame.offset);
  element('tick').textContent = String(tick.tick);
  element('epoch').textContent = String(tick.epoch);
  element('rate').textContent = String(arrivals.length);
  element('dropped').textContent = String(dropped);
  const row = document.createElement('tr');
  for (const cell of [frame.offset, tick.tick, tick.keyframe ? 'yes' : '']) {
    row.append(Object.assign(document.createElement('td'), { textContent: String(cell) }));
  }
  const recent = element('recent');
  recent.prepend(row);
  while (recent.childElementCount > RECENT) recent.lastElementChild!.remove();
}

function showLegs() {
  const ms = (us: number) => (Number.isNaN(us) ? '-' : (us / 1000).toFixed(2));
  element('legs').replaceChildren(
    ...LEGS.map((leg) => {
      const { p50, p99 } = legs.summary(leg.id);
      const row = document.createElement('tr');
      row.title = leg.what;
      for (const cell of [leg.name, ms(p50), ms(p99)]) {
        row.append(Object.assign(document.createElement('td'), { textContent: cell }));
      }
      return row;
    }),
  );
}

async function main() {
  await loadCore();
  // The dev IdP mints an ID token for anyone; a real page signs in with PKCE.
  const answer = await fetch(`${IDP}/token?sub=${encodeURIComponent(user)}&aud=felix-arena`);
  const { id_token: token } = (await answer.json()) as { id_token: string };
  const gateway = await Gateway.connect(GATEWAY, arena, token);
  gateway.onError = (err) => show(`${err.code}: ${err.message}`, 'down');
  await gateway.subscribe('ticks', 'live', 'live', onTick);
  show(`live as ${user}`, 'live');
  setInterval(showLegs, 500);
}

main().catch((err: unknown) => show(String(err), 'down'));
