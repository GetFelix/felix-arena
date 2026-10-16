// The frame-time benchmark: `play.html?offline&bench` plays a busy offline match for two minutes at a drawing size of
// 1920x1080, with your craft flying circles and firing, and reports the frame times and the tier it drew at.
import { percentile, type Tier } from './quality';
import type { Control } from './prediction';

const FIRE = 1;
const BOOST = 2;
/** The drawing size the frame-time target is set at. */
export const BENCH_SIZE = [1920, 1080] as const;
/** Seconds drawn before measuring when the tier is forced, so shaders are compiled and caches warm. */
const WARMUP_S = 3;

/** What the benchmark found. */
export interface BenchReport {
  tier: Tier;
  chosen: 'auto' | 'forced';
  seconds: number;
  frames: number;
  fps: number;
  /** Time between frames, in milliseconds. */
  intervalP50: number;
  intervalP95: number;
  intervalP99: number;
  /** Frames more than 20 ms after the one before, as a share of all frames. */
  slowShare: number;
  /** The page's own work each frame, update and draw calls, in milliseconds. */
  workP50: number;
  workP95: number;
  canvas: string;
  gpu: string;
  browser: string;
}

/** Runs the benchmark once the tier is settled, and shows its report when done. */
export class Bench {
  private startAt: number | null = null;
  private last: number | null = null;
  private readonly intervals: number[] = [];
  private readonly work: number[] = [];
  report: BenchReport | null = null;

  constructor(
    private readonly seconds: number,
    private readonly forced: boolean,
    private readonly gpu: string,
  ) {}

  /** Your craft's controls at time `t`: a wide circle, the aim sweeping round, the gun always firing. */
  controls(t: number): Control {
    const a = t * 0.8;
    return {
      moveX: Math.round(Math.cos(a) * 127),
      moveZ: Math.round(Math.sin(a) * 127),
      aim: Math.round(t * 9000) & 0xffff,
      buttons: FIRE | (t % 4 < 0.3 ? BOOST : 0),
    };
  }

  /**
   * Counts a frame that started at `now` and took `work` ms of the page's time, once `settled` (the tier chosen).
   * Returns true when the benchmark has just finished.
   */
  frame(now: number, work: number, settled: boolean, tier: Tier, canvas: HTMLCanvasElement): boolean {
    if (this.report || !settled) return false;
    this.startAt ??= now + (this.forced ? WARMUP_S * 1000 : 0);
    if (now < this.startAt) return false;
    if (this.last !== null) this.intervals.push(now - this.last);
    this.last = now;
    this.work.push(work);
    const elapsed = now - this.startAt;
    if (elapsed < this.seconds * 1000) return false;
    const intervals = [...this.intervals];
    const round = (x: number) => Math.round(x * 100) / 100;
    this.report = {
      tier,
      chosen: this.forced ? 'forced' : 'auto',
      seconds: round(elapsed / 1000),
      frames: this.intervals.length,
      fps: round((this.intervals.length * 1000) / elapsed),
      intervalP50: round(percentile(intervals, 50)),
      intervalP95: round(percentile(intervals, 95)),
      intervalP99: round(percentile(intervals, 99)),
      slowShare: round(this.intervals.filter((i) => i > 20).length / this.intervals.length),
      workP50: round(percentile(this.work, 50)),
      workP95: round(percentile(this.work, 95)),
      canvas: `${canvas.width}x${canvas.height}`,
      gpu: this.gpu,
      browser: navigator.userAgent,
    };
    return true;
  }
}

/** The GPU the browser reports, where it reports one. */
export function gpuName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}
