// Pending Bun matchers re-enter the event loop and can lose pipe or WebSocket events.
export async function rejectionOf(promise: PromiseLike<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject, but it resolved.');
}

export async function throwingRejectionOf(promise: PromiseLike<unknown>): Promise<() => never> {
  const error = await rejectionOf(promise);
  return () => { throw error; };
}
