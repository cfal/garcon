export interface BoundedLruCacheOptions<V> {
  readonly maxEntries: number;
  readonly maxBytes: number;
  // Estimated retained size of one value; the cache never re-measures a stored value.
  readonly sizeOf: (value: V) => number;
}

// Least-recently-used cache bounded by entry count and estimated bytes. Inserting
// evicts the oldest entries until both bounds hold; a value larger than the byte
// bound is not retained at all.
export class BoundedLruCache<K, V> {
  readonly #options: BoundedLruCacheOptions<V>;
  readonly #entries = new Map<K, { value: V; bytes: number }>();
  #bytes = 0;

  constructor(options: BoundedLruCacheOptions<V>) {
    this.#options = options;
  }

  get size(): number { return this.#entries.size; }

  get bytes(): number { return this.#bytes; }

  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    this.delete(key);
    const bytes = this.#options.sizeOf(value);
    if (bytes > this.#options.maxBytes || this.#options.maxEntries <= 0) return;
    this.#entries.set(key, { value, bytes });
    this.#bytes += bytes;
    for (const [oldest, entry] of this.#entries) {
      if (this.#entries.size <= this.#options.maxEntries && this.#bytes <= this.#options.maxBytes) break;
      this.#entries.delete(oldest);
      this.#bytes -= entry.bytes;
    }
  }

  delete(key: K): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }
}
