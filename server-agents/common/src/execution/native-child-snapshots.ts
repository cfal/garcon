import { AgentIntegrationError } from '@garcon/server-agent-interface';

const KNOWN_CHILDREN = 1024;

interface NativeRead { readonly rootId: string; changed: boolean }

// Positive source evidence is process-local. Proof-cache eviction and restart mean unknown.
export class NativeChildSnapshots {
  readonly #known = new Map<string, { readonly rootId: string }>();
  readonly #admissions = new Map<string, number>();
  readonly #reads = new Set<NativeRead>();

  constructor(private readonly assertNativeIdle: (rootId: string) => void) {}

  remember(childKey: string, rootId: string): void {
    if (this.#known.has(childKey)) return;
    if (this.#known.size >= KNOWN_CHILDREN) this.#known.delete(this.#known.keys().next().value!);
    this.#known.set(childKey, { rootId });
  }

  activity(rootId: string): void {
    for (const read of this.#reads) if (read.rootId === rootId) read.changed = true;
  }

  admit(rootId: string): () => void {
    this.activity(rootId);
    this.#admissions.set(rootId, (this.#admissions.get(rootId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.#admissions.get(rootId) ?? 1) - 1;
      if (remaining) this.#admissions.set(rootId, remaining);
      else this.#admissions.delete(rootId);
    };
  }

  capture(childKey: string): { assertUnchanged(): void; release(): void } {
    const known = this.#known.get(childKey);
    if (!known) throw new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE',
      'Native child writer exit cannot be verified after executor restart or proof-cache eviction', false);
    const read: NativeRead = { rootId: known.rootId, changed: false };
    const assertUnchanged = () => {
      if (read.changed || this.#admissions.has(known.rootId)) {
        throw new AgentIntegrationError('SESSION_BUSY', 'The native child source is running or changed', true);
      }
      if (this.#known.get(childKey) !== known) throw new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE', 'Native child source proof expired', false);
      this.assertNativeIdle(known.rootId);
    };
    assertUnchanged();
    this.#reads.add(read);
    return { assertUnchanged, release: () => { this.#reads.delete(read); } };
  }
}
