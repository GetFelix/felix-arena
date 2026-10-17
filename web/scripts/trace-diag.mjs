// TEMPORARY diagnostics: what a slow measured window on the page's main thread was doing.
// Windows come from performance.measure(name) calls in the page (blink.user_timing).
export const CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'v8',
  'v8.execute',
  'disabled-by-default-v8.gc',
  'blink.user_timing',
  'gpu',
  'toplevel',
  'blink',
];

export function analyse(buffer, name, top = 12) {
  const events = JSON.parse(buffer.toString()).traceEvents ?? JSON.parse(buffer.toString());
  const threads = new Map();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args.name);
  const marks = events.filter((e) => e.cat?.includes('blink.user_timing') && e.name === name);
  const begins = marks.filter((e) => e.ph === 'b' || e.ph === 'B');
  const ends = marks.filter((e) => e.ph === 'e' || e.ph === 'E');
  const windows = begins.map((b) => {
    const e = ends.find((x) => x.id === b.id && x.ts >= b.ts) ?? ends.find((x) => x.ts >= b.ts);
    return { start: b.ts, end: e.ts, pid: b.pid, tid: b.tid };
  });
  if (!windows.length) return { name, windows: 0 };
  const pid = windows[0].pid;
  const main = [...threads].find(([k, v]) => v === 'CrRendererMain' && k.startsWith(`${pid}:`))?.[0];
  const mainEvents = events.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === 'X');
  // Events overlapping each window, with their wall and thread time clipped to the window.
  const rows = windows.map((w) => {
    const wall = (w.end - w.start) / 1000;
    const inside = mainEvents.filter((e) => e.ts < w.end && e.ts + (e.dur ?? 0) > w.start);
    const gc = inside
      .filter((e) => /GC|Scavenge|MarkCompact|Sweep/.test(e.name) && e.ts >= w.start)
      .reduce((s, e) => s + (e.dur ?? 0), 0);
    // The enclosing task's thread time vs wall time tells running from waiting (descheduled or blocked).
    const task = inside
      .filter((e) => e.ts <= w.start && e.ts + e.dur >= w.end && e.tdur !== undefined)
      .sort((a, b) => a.dur - b.dur)[0];
    const leaves = inside
      .filter((e) => e.ts >= w.start && e.ts + e.dur <= w.end && e.dur > 100)
      .sort((a, b) => b.dur - a.dur)
      .slice(0, 6)
      .map((e) => `${e.name}:${(e.dur / 1000).toFixed(2)}/${((e.tdur ?? 0) / 1000).toFixed(2)}`);
    return {
      wall: Number(wall.toFixed(3)),
      gcMs: Number((gc / 1000).toFixed(3)),
      task: task && `${task.name} wall ${(task.dur / 1000).toFixed(2)} cpu ${(task.tdur / 1000).toFixed(2)}`,
      taskIdle: task ? Number(((task.dur - task.tdur) / 1000).toFixed(3)) : null,
      leaves,
    };
  });
  const sorted = [...rows].sort((a, b) => b.wall - a.wall);
  const walls = rows.map((r) => r.wall).sort((a, b) => a - b);
  const pct = (p) => walls[Math.min(walls.length - 1, Math.floor(p * walls.length))];
  return {
    name,
    windows: rows.length,
    p50: pct(0.5),
    p95: pct(0.95),
    max: walls.at(-1),
    withGc: rows.filter((r) => r.gcMs > 0).length,
    slowest: sorted.slice(0, top),
    medianTaskIdle: [...rows].map((r) => r.taskIdle ?? 0).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  };
}
