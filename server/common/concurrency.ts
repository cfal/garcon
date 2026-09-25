export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('Concurrency limit must be a positive integer');
  }
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const promise = Promise.resolve().then(() => worker(item));
    executing.add(promise);
    void promise.then(
      () => executing.delete(promise),
      () => executing.delete(promise),
    );
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
}

export async function mapWithConcurrencyResult<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  await mapWithConcurrency(
    items.map((item, index) => ({ item, index })),
    limit,
    async ({ item, index }) => {
      results[index] = await worker(item, index);
    },
  );
  return results;
}
