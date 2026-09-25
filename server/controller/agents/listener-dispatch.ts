export async function dispatchListenersSequentially<Args extends readonly unknown[]>(
  listeners: Iterable<(...args: Args) => void | Promise<void>>,
  args: Args,
  onError: (error: unknown) => void,
): Promise<void> {
  for (const listener of listeners) {
    try {
      await listener(...args);
    } catch (error) {
      onError(error);
    }
  }
}
