// The live HUD: score and clock, kill feed, your hull, boost and rail, the warmup and respawn banners, and the
// scoreboard, which Tab shows and the results screen holds open.
import { callsign, clock, type Kill, type Match, type Standing } from './match';

/** The key a kill's element carries, which {@link killKey} gives back for a click. */
export function killKey(kill: Kill): string {
  return kill.replay ? `${kill.matchNumber}:${kill.replay.offset}:${kill.victim}` : '';
}

/** Your craft, as far as the HUD cares. */
export interface Status {
  slot: number;
  alive: boolean;
  health: number;
  /** 0 when the boost is ready, up to 1 just after a dash. */
  boostCooling: number;
  rail: number;
  /** Seconds until you respawn, while dead. */
  respawnIn: number | null;
}

const el = (id: string) => document.getElementById(id)!;

/** Writes the HUD. Only what changed is touched, so a frame costs little. */
export class Hud {
  private readonly shown = new Map<string, string>();

  update(match: Match, me: Status | null, scoreboard: boolean, nowMs: number): void {
    this.text('coral', String(match.scores[0]));
    this.text('violet', String(match.scores[1]));
    this.text('clock', clock(match.seconds));
    this.text('phase', match.phase === 'warmup' ? 'WARMUP' : match.phase === 'results' ? 'MATCH OVER' : '');

    const feed = match
      .kills(nowMs)
      .map((k) => {
        const team = (slot: number) => (match.standings().find((s) => s.slot === slot)?.violet ? 'violet' : 'coral');
        const how = k.rail ? 'railed' : 'eliminated';
        return `<div${k.replay ? ` data-kill="${killKey(k)}" title="Replay"` : ''}><span class="${team(k.killer)}">${callsign(k.killer)}</span><span class="x">${how}</span><span class="${team(k.victim)}">${callsign(k.victim)}</span></div>`;
      })
      .join('');
    this.html('feed', feed);

    let banner: [string, string] | null = null;
    if (match.phase === 'warmup') {
      banner = match.waiting
        ? ['WARMUP', 'Waiting for a second player']
        : ['WARMUP', `Match starts in ${match.seconds}`];
    } else if (match.phase === 'playing' && me && !me.alive && me.respawnIn !== null) {
      banner = ['DESTROYED', `Respawning in ${Math.max(1, Math.ceil(me.respawnIn))}`];
    }
    this.hide('banner', !banner);
    if (banner) {
      this.text('banner-title', banner[0]);
      this.text('banner-sub', banner[1]);
    }

    this.hide('me', !me || match.phase === 'results');
    if (me) {
      this.style('health', `${me.alive ? me.health : 0}%`);
      this.style('boost', `${Math.round((1 - me.boostCooling) * 100)}%`);
      this.html('rail', [0, 1, 2].map((i) => `<i${i < me.rail ? ' class="on"' : ''}></i>`).join(''));
    }

    const board = match.phase === 'results' || scoreboard;
    this.hide('board', !board);
    if (board) this.board(match, me?.slot ?? null);
  }

  /** The replays panel: every kill held, by match, newest match first. `note` says what an earlier match's load did. */
  replays(match: Match, open: boolean, note: string): void {
    this.hide('replays', !open);
    if (!open) return;
    const teams = new Map(match.standings().map((s) => [s.slot, s.violet]));
    const team = (slot: number) => (teams.get(slot) ? 'violet' : 'coral');
    const held = match.replays();
    if (!held.some(([n]) => n === match.number)) held.unshift([match.number, []]);
    const html = held
      .map(([number, kills]) => {
        const rows = [...kills]
          .reverse()
          .map(
            (k) =>
              `<button class="kill" data-kill="${killKey(k)}"${k.replay ? '' : ' disabled'}><span class="t">${clock(k.seconds)}</span><span class="${team(k.killer)}">${callsign(k.killer)}</span><span class="x">${k.rail ? 'railed' : 'eliminated'}</span><span class="${team(k.victim)}">${callsign(k.victim)}</span></button>`,
          )
          .join('');
        const title = number === match.number ? `Match ${number + 1} · now` : `Match ${number + 1}`;
        return `<section><h4>${title}</h4>${rows || '<p>No kills yet</p>'}</section>`;
      })
      .join('');
    this.html('replays-list', html);
    this.text('replays-note', note);
  }

  private board(match: Match, mine: number | null): void {
    const [coral, violet] = match.scores;
    const title =
      match.phase !== 'results'
        ? 'SCOREBOARD'
        : coral === violet
          ? 'DRAW'
          : `${coral > violet ? 'CORAL' : 'VIOLET'} WINS`;
    this.text('board-title', title);
    const titleEl = el('board-title');
    titleEl.className = match.phase === 'results' && coral !== violet ? (coral > violet ? 'coral' : 'violet') : '';
    this.text('board-coral', String(coral));
    this.text('board-violet', String(violet));
    const rows = (players: Standing[]) =>
      players
        .map(
          (p) =>
            `<tr${p.slot === mine ? ' class="you"' : ''}><td>${callsign(p.slot)}</td><td>${p.kills}</td><td>${p.deaths}</td></tr>`,
        )
        .join('');
    const standings = match.standings();
    this.html('board-coral-players', rows(standings.filter((p) => !p.violet)));
    this.html('board-violet-players', rows(standings.filter((p) => p.violet)));
    this.text(
      'board-next',
      match.phase === 'results' ? `Next match in ${clock(match.seconds)}` : `${clock(match.seconds)} left`,
    );
  }

  private text(id: string, value: string): void {
    if (this.shown.get(id) === value) return;
    this.shown.set(id, value);
    el(id).textContent = value;
  }

  private html(id: string, value: string): void {
    if (this.shown.get(`${id}<`) === value) return;
    this.shown.set(`${id}<`, value);
    el(id).innerHTML = value;
  }

  private style(id: string, width: string): void {
    if (this.shown.get(`${id}%`) === width) return;
    this.shown.set(`${id}%`, width);
    el(id).style.width = width;
  }

  private hide(id: string, hidden: boolean): void {
    el(id).hidden = hidden;
  }
}
