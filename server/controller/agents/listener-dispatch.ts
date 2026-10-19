export async function dispatchListenersSequentially<Args extends readonly unknown[]>(
  listeners: Iterable<(...args: Args) => void | Promise<void>>,
  args: Args,
  onError: (error: unknown) => void,
): Promise<void> {
  for (const listener of listeners) {
    try {
      const pending = listener(...args);
      // Synchronous observers must not delay transcript fanout behind terminal broadcasts.
      if (pending) await pending;
    } catch (error) {
      onError(error);
    }
  }
}
