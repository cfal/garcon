export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('Concurrency limit must be a positive integer');
  }
  let next = 0;
  let failure: { error: unknown } | undefined;
  const run = async () => {
    while (!failure && next < items.length) {
      const item = items[next++]!;
      try { await worker(item); }
      catch (error) { failure ??= { error }; }
    }
  };
  // Settles admitted siblings before releasing the caller's resource ownership.
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => Promise.resolve().then(run)));
  if (failure) throw failure.error;
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
