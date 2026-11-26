export const NATIVE_CHILD_CAPTURE_LIMITS = {
  children: 1024, earlyPerChild: 128, earlyBytesPerChild: 1024 * 1024,
  earlyPerSource: 1024, earlyBytesPerSource: 4 * 1024 * 1024,
  identitiesPerChild: 4096, identitiesPerSource: 16384, identityBytesPerSource: 4 * 1024 * 1024,
} as const;

interface Pending<T> { readonly frames: T[]; bytes: number }
interface Identities { readonly ids: Set<string>; bytes: number }

// Identity overflow ends capture; eviction would admit previously seen native rows again.
export class NativeChildCaptureBudget<T> {
  readonly #early = new Map<string, Pending<T>>();
  readonly #seen = new Map<string, Identities>();
  #earlyCount = 0;
  #earlyBytes = 0;
  #identityCount = 0;
  #identityBytes = 0;

  get pendingChildren(): number { return this.#early.size; }

  buffer(key: string, frame: T): 'buffered' | 'child-limit' | 'source-limit' {
    const limits = NATIVE_CHILD_CAPTURE_LIMITS;
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    const pending = this.#early.get(key) ?? { frames: [], bytes: 0 };
    if (pending.frames.length >= limits.earlyPerChild || pending.bytes + bytes > limits.earlyBytesPerChild) return 'child-limit';
    if (this.#earlyCount >= limits.earlyPerSource || this.#earlyBytes + bytes > limits.earlyBytesPerSource
      || (!this.#early.has(key) && this.#early.size >= limits.children)) return 'source-limit';
    pending.frames.push(frame);
    pending.bytes += bytes;
    this.#early.set(key, pending);
    this.#earlyCount++;
    this.#earlyBytes += bytes;
    return 'buffered';
  }

  take(key: string): readonly T[] {
    const pending = this.#early.get(key);
    if (!pending) return [];
    this.#early.delete(key);
    this.#earlyCount -= pending.frames.length;
    this.#earlyBytes -= pending.bytes;
    return pending.frames;
  }

  remember(key: string, id: string): 'new' | 'duplicate' | 'limit' {
    const limits = NATIVE_CHILD_CAPTURE_LIMITS;
    const seen = this.#seen.get(key) ?? { ids: new Set<string>(), bytes: 0 };
    if (seen.ids.has(id)) return 'duplicate';
    const bytes = Buffer.byteLength(id);
    if (seen.ids.size >= limits.identitiesPerChild || this.#identityCount >= limits.identitiesPerSource
      || this.#identityBytes + bytes > limits.identityBytesPerSource
      || (!this.#seen.has(key) && this.#seen.size >= limits.children)) return 'limit';
    seen.ids.add(id);
    seen.bytes += bytes;
    this.#seen.set(key, seen);
    this.#identityCount++;
    this.#identityBytes += bytes;
    return 'new';
  }

  forget(key: string): void {
    this.take(key);
    const seen = this.#seen.get(key);
    if (!seen) return;
    this.#identityCount -= seen.ids.size;
    this.#identityBytes -= seen.bytes;
    this.#seen.delete(key);
  }

  clear(): void {
    this.#early.clear();
    this.#seen.clear();
    this.#earlyCount = this.#earlyBytes = this.#identityCount = this.#identityBytes = 0;
  }
}
