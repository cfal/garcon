// Resolves after pending socket and timer callbacks have had a turn, so bulk work split into
// bounded steps cannot starve WebSocket liveness or other chats. A resolved promise alone
// would continue in the microtask queue without letting any I/O run.
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
