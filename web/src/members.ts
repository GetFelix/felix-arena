// The member list (docs/design.md, "Data model"): each open session keeps a key in its arena's member cache,
// written again every third of the cache's TTL, so a tab that closes without saying so drops out within one TTL.
// A tab that closes normally deletes its key at once with a beacon the browser sends after the page is gone.
import type { Gateway } from './gateway';

const CACHE = 'members';
const DEFAULT_TTL_MS = 30_000;

/** A random session key, which names nobody. */
export function sessionKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What a member's entry holds: whether it plays or watches, and who it is. */
export function memberEntry(role: 'play' | 'watch', name: string): Uint8Array {
  return new TextEncoder().encode(`${role}:${name}`);
}

/** The gateway's leave endpoint, from its WebSocket URL. */
export function leaveUrl(gatewayWs: string): string {
  const url = new URL(gatewayWs);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/members/leave';
  return url.toString();
}

/**
 * Keep `key` in `arena`'s list until the page goes. `token` is the ID token the session joined with, which the leave
 * beacon needs.
 */
export function joinMembers(
  gateway: Gateway,
  gatewayWs: string,
  arena: string,
  token: string,
  role: 'play' | 'watch',
  name: string,
  key = sessionKey(),
): { key: string; stop: () => void } {
  const entry = memberEntry(role, name);
  const write = () => gateway.cachePut(CACHE, key, entry);
  write();
  const timer = setInterval(write, (gateway.cacheTtlMs[CACHE] ?? DEFAULT_TTL_MS) / 3);
  const leave = () => {
    clearInterval(timer);
    navigator.sendBeacon(leaveUrl(gatewayWs), JSON.stringify({ arena, token, cache: CACHE, key }));
  };
  addEventListener('pagehide', leave, { once: true });
  // A page kept in the back-forward cache has lost its session and its key, so it starts again when it comes back.
  addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
  return {
    key,
    stop: () => {
      removeEventListener('pagehide', leave);
      clearInterval(timer);
      gateway.cacheDelete(CACHE, key);
    },
  };
}
