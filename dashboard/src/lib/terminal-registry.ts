/**
 * Cross-Terminal coordination, shared by every <Terminal> instance through
 * module singletons. Two concerns:
 *   - Connection tracking: how many terminals are currently connecting, so the
 *     UI can show a "connecting" indicator.
 *   - Server-alive fan-out: when one terminal connects, others stuck in reconnect
 *     backoff retry immediately (avoids staggered reconnects after a restart).
 */

// --- Connection tracking ---------------------------------------------------

const pendingTerminals = new Set<string>();
const connectionListeners = new Set<() => void>();

function notifyConnectionChange(): void {
  for (const fn of connectionListeners) fn();
}

export function getPendingTerminalCount(): number {
  return pendingTerminals.size;
}

export function onTerminalConnectionChange(fn: () => void): () => void {
  connectionListeners.add(fn);
  return () => { connectionListeners.delete(fn); };
}

/** A terminal started connecting. */
export function markTerminalConnecting(sessionId: string): void {
  pendingTerminals.add(sessionId);
  notifyConnectionChange();
}

/** A terminal finished connecting, disconnected, or unmounted. */
export function markTerminalSettled(sessionId: string): void {
  pendingTerminals.delete(sessionId);
  notifyConnectionChange();
}

// --- Server-alive fan-out --------------------------------------------------

const serverAliveListeners = new Set<() => void>();

/** Tell every terminal that a server connection just succeeded. */
export function notifyServerAlive(): void {
  for (const fn of serverAliveListeners) fn();
}

/** Subscribe to server-alive notifications; returns an unsubscribe function. */
export function subscribeServerAlive(fn: () => void): () => void {
  serverAliveListeners.add(fn);
  return () => { serverAliveListeners.delete(fn); };
}
