// The order the background tracks play in: every track once, shuffled, then again, never the same track twice in a row.

export class Playlist {
  private queue: string[] = [];
  private last: string | null = null;

  constructor(
    private readonly tracks: readonly string[],
    private readonly random: () => number,
  ) {
    if (tracks.length === 0) throw new Error('a playlist needs a track');
  }

  next(): string {
    if (this.queue.length === 0) this.queue = this.shuffled();
    const track = this.queue.shift()!;
    this.last = track;
    return track;
  }

  private shuffled(): string[] {
    const order = [...this.tracks];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    // A new round must not open with the track that just closed the last one.
    if (order.length > 1 && order[0] === this.last) order.push(order.shift()!);
    return order;
  }
}
