// The browser end of felix-gateway's protocol, as much of it as the game uses:
// join, and subscriptions in named slots whose events arrive as binary frames.
// felix-gateway's docs/protocol.md is the reference.

/** The optional protocol features the game needs. */
export const FEATURES = ['binary_events', 'slots'] as const;

/** One event frame from the gateway. Times are µs since the Unix epoch. */
export interface EventFrame {
  /** The subscription, as its `subscribed` numbered it. */
  sub: number;
  /** The log offset, or `null` on a stream with no log. */
  offset: number | null;
  skippedBefore: number;
  /** When the gateway received the event from Felix, on its clock. */
  gatewayReceivedUs: number;
  /** When the gateway handed the frame to the WebSocket, on its clock. */
  gatewaySentUs: number;
  /** When this page received the frame, on its own clock. */
  receivedUs: number;
  payload: Uint8Array;
}

const EVENT_KIND = 1;
const NO_OFFSET = 0xffff_ffff_ffff_ffffn;
const MIN_HEADER = 40;

/** Parse one binary frame, or `null` for a kind this client does not know. */
export function parseFrame(data: ArrayBuffer, receivedUs = nowUs()): EventFrame | null {
  const view = new DataView(data);
  if (data.byteLength < 2 || view.getUint8(0) !== EVENT_KIND) return null;
  // The header may grow; the payload starts where its length byte says.
  const headerLen = view.getUint8(1);
  if (headerLen < MIN_HEADER || data.byteLength < headerLen) return null;
  const offset = view.getBigUint64(8, true);
  return {
    sub: view.getUint32(4, true),
    offset: offset === NO_OFFSET ? null : Number(offset),
    skippedBefore: view.getUint32(16, true),
    gatewayReceivedUs: Number(view.getBigUint64(24, true)),
    gatewaySentUs: Number(view.getBigUint64(32, true)),
    receivedUs,
    payload: new Uint8Array(data, headerLen),
  };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Microseconds since the Unix epoch on this host's clock. */
export function nowUs(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 1000);
}

/** What `subscribed` reports. */
export interface Subscribed {
  sub: number;
  startOffset: number | null;
  liveOffset: number | null;
}

/** An error the gateway answered with. */
export class GatewayError extends Error {
  override name = 'GatewayError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

interface Pending {
  onEvent: (frame: EventFrame) => void;
  resolve: (subscribed: Subscribed) => void;
  reject: (err: Error) => void;
}

/** One joined session on the gateway. */
export class Gateway {
  /** Frame handlers by subscription number. */
  private readonly handlers = new Map<number, (frame: EventFrame) => void>();
  /** The current subscription number of each `stream/slot`. */
  private readonly slots = new Map<string, number>();
  /** Subscribes waiting for an answer, oldest first, by `stream/slot`. */
  private readonly pending = new Map<string, Pending[]>();
  /** Publishes waiting for an `ack`, by id. */
  private readonly publishes = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();
  private nextId = 1;
  private closing = false;
  /** Called with errors that answer no pending request, such as `subscription_ended`. */
  onError: (err: GatewayError) => void = () => {};

  private constructor(
    private readonly socket: WebSocket,
    /** Aliases of optional resources this sign-in does not reach, from `hello`. */
    readonly missing: readonly string[],
  ) {
    socket.addEventListener('message', (message) => this.receive(message));
    socket.addEventListener('close', () => {
      if (!this.closing) this.onError(new GatewayError('closed', 'the gateway closed the session'));
    });
  }

  /** Open a session on `arena` with an ID token, asking for {@link FEATURES}. */
  static connect(url: string, arena: string, token: string): Promise<Gateway> {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    return new Promise((resolve, reject) => {
      const fail = (err: Error) => {
        socket.close();
        reject(err);
      };
      socket.addEventListener('error', () => fail(new Error(`cannot reach ${url}`)), { once: true });
      socket.addEventListener('open', () =>
        socket.send(JSON.stringify({ type: 'join', protocol: 1, features: FEATURES, arena, token })),
      );
      socket.addEventListener(
        'message',
        (message) => {
          const hello = JSON.parse(String(message.data)) as Json;
          if (hello.type !== 'hello') {
            return fail(new GatewayError(String(hello.code), String(hello.message)));
          }
          const features = hello.features as string[];
          const missing = FEATURES.filter((feature) => !features.includes(feature));
          if (missing.length > 0) return fail(new Error(`the gateway lacks ${missing.join(', ')}`));
          resolve(new Gateway(socket, (hello.missing as string[] | undefined) ?? []));
        },
        { once: true },
      );
    });
  }

  /**
   * Subscribe to `stream` in `slot`, from `"live"` or a log offset. Replaces
   * any earlier subscription in the same slot; frames of the old one stop
   * reaching their handler.
   */
  subscribe(
    stream: string,
    slot: string,
    from: number | 'live',
    onEvent: (frame: EventFrame) => void,
  ): Promise<Subscribed> {
    const key = `${stream}/${slot}`;
    return new Promise((resolve, reject) => {
      const queue = this.pending.get(key) ?? [];
      queue.push({ onEvent, resolve, reject });
      this.pending.set(key, queue);
      this.socket.send(JSON.stringify({ type: 'subscribe', stream, slot, from }));
    });
  }

  /**
   * Publish `payload` to `stream`, fire and forget: a refusal arrives at
   * {@link onError}. Inputs go this way, since the next one supersedes a lost one.
   */
  send(stream: string, payload: Uint8Array): void {
    this.socket.send(
      JSON.stringify({ type: 'publish', stream, payload: base64(payload), ack: false, id: this.nextId++ }),
    );
  }

  /** Publish `payload` to `stream` and wait for Felix to take it. */
  publish(stream: string, payload: Uint8Array): Promise<void> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.publishes.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ type: 'publish', stream, payload: base64(payload), ack: true, id }));
    });
  }

  close(): void {
    this.closing = true;
    this.socket.close();
  }

  /**
   * The oldest unanswered subscribe for this answer. The gateway answers a
   * connection's subscribes in order, each with `subscribed` or an error.
   * An error that names no slot is matched by its stream alone.
   */
  private answered(json: Json): { key: string; request: Pending; superseded: boolean } | null {
    let key = `${String(json.stream)}/${String(json.slot)}`;
    if (json.slot === undefined && !this.pending.has(key)) {
      key = [...this.pending.keys()].find((k) => k.startsWith(`${String(json.stream)}/`)) ?? key;
    }
    const queue = this.pending.get(key);
    const request = queue?.shift();
    if (!queue || !request) return null;
    if (queue.length === 0) this.pending.delete(key);
    return { key, request, superseded: queue.length > 0 };
  }

  private receive(message: MessageEvent): void {
    if (message.data instanceof ArrayBuffer) {
      const frame = parseFrame(message.data);
      if (frame) this.handlers.get(frame.sub)?.(frame);
      return;
    }
    const json = JSON.parse(String(message.data)) as Json;
    if (json.type === 'subscribed') {
      const answer = this.answered(json);
      if (!answer) return;
      const { key, request, superseded } = answer;
      const previous = this.slots.get(key);
      if (previous !== undefined) this.handlers.delete(previous);
      // A later subscribe to the same slot replaces this one at the gateway.
      if (superseded) {
        this.slots.delete(key);
        return request.reject(new Error('replaced'));
      }
      const sub = json.sub as number;
      this.slots.set(key, sub);
      this.handlers.set(sub, request.onEvent);
      request.resolve({
        sub,
        startOffset: json.start_offset as number | null,
        liveOffset: json.live_offset as number | null,
      });
    } else if (json.type === 'ack') {
      const id = json.id as number;
      this.publishes.get(id)?.resolve();
      this.publishes.delete(id);
    } else if (json.type === 'error') {
      const err = new GatewayError(String(json.code), String(json.message));
      const publish = typeof json.id === 'number' ? this.publishes.get(json.id) : undefined;
      if (publish) {
        this.publishes.delete(json.id as number);
        return publish.reject(err);
      }
      // `subscription_ended` follows a `subscribed`, and an error with an id
      // answers a publish, so neither answers a subscribe.
      const answer = json.code === 'subscription_ended' || json.id !== undefined ? null : this.answered(json);
      if (answer) answer.request.reject(err);
      else this.onError(err);
    }
  }
}
