import { GIT_MAX_RESULT_BYTES, GIT_MAX_RETAINED_RESULT_BYTES, GIT_RESULT_CHUNK_BYTES } from '../../common/git-execution.js';
import { GitServiceError } from '../../common/git-error.js';
import { isRecord } from '../../common/json.js';
import { invalidGitResult, validateGitResultRef, type GitReply, type GitResultRef, type GitResultScope } from './git-protocol.js';

interface ResultEntry {
  readonly ref: GitResultRef;
  readonly bytes: Buffer;
  readonly release: () => void;
  readonly deadline: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class GitResultTransfers {
  readonly #entries = new Map<string, ResultEntry>();
  #reserved = 0;
  #count = 0;
  #disposed = false;
  constructor(private readonly scope: GitResultScope, private readonly now = Date.now) {}

  async produce<T>(operation: () => Promise<T>, options: { signal: AbortSignal; budgetMs: number; mutation?: boolean }): Promise<GitReply<T>> {
    this.#check(options.signal);
    if (options.mutation) {
      const value = await operation();
      // Mutation diagnostics must remain inline even after a successful hook emits large output.
      if (Buffer.byteLength(JSON.stringify(value)) > GIT_RESULT_CHUNK_BYTES) throw new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Git mutation result is too large to confirm. Inspect the repository before trying again.');
      return { ...this.scope, kind: 'inline', value };
    }
    const release = this.#reserve();
    const deadline = this.now() + options.budgetMs;
    let retained = false;
    try {
      const value = await operation();
      this.#check(options.signal);
      const encoded = JSON.stringify(value);
      const size = Buffer.byteLength(encoded);
      if (size > GIT_MAX_RESULT_BYTES) throw new GitServiceError('GIT_RESULT_TOO_LARGE', 'Git query result exceeds the transfer limit');
      if (size <= GIT_RESULT_CHUNK_BYTES - 4096) return { ...this.scope, kind: 'inline', value };
      if (this.now() >= deadline) throw new GitServiceError('GIT_TIMEOUT', 'Git result deadline expired');
      const bytes = Buffer.from(encoded);
      const ref: GitResultRef = { ...this.scope, kind: 'git-result', id: crypto.randomUUID() };
      const timer = setTimeout(() => this.close(ref), Math.min(120_000, deadline - this.now()));
      timer.unref();
      this.#entries.set(ref.id, { ref, bytes, release, timer, deadline });
      retained = true;
      return { ...this.scope, kind: 'transfer', transfer: ref, size };
    } finally { if (!retained) release(); }
  }

  readChunk(request: { transfer: GitResultRef; offset: number }, signal: AbortSignal) {
    this.#check(signal);
    if (!isRecord(request)) throw invalidGitResult();
    validateGitResultRef(request.transfer, this.scope);
    const entry = this.#entries.get(request.transfer.id);
    if (!entry || entry.deadline <= this.now()) {
      this.close(request.transfer);
      throw new GitServiceError('GIT_STALE_DOCUMENT', 'Git result expired. Refresh the query.');
    }
    if (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > entry.bytes.length) throw invalidGitResult();
    const end = Math.min(request.offset + GIT_RESULT_CHUNK_BYTES, entry.bytes.length);
    return { offset: request.offset, data: entry.bytes.subarray(request.offset, end).toString('base64'), eof: end === entry.bytes.length };
  }

  close(ref: GitResultRef): void {
    validateGitResultRef(ref, this.scope);
    const entry = this.#entries.get(ref.id);
    if (!entry) return;
    this.#entries.delete(ref.id);
    clearTimeout(entry.timer);
    entry.release();
  }

  dispose(): void {
    this.#disposed = true;
    for (const entry of this.#entries.values()) this.close(entry.ref);
  }

  #check(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.#disposed) throw new GitServiceError('GIT_UNAVAILABLE', 'Git result session retired');
  }

  #reserve(): () => void {
    if (this.#count >= 8 || this.#reserved + GIT_MAX_RESULT_BYTES > GIT_MAX_RETAINED_RESULT_BYTES) throw new GitServiceError('GIT_SERVICE_BUSY', 'Too many open Git query results');
    this.#count++;
    this.#reserved += GIT_MAX_RESULT_BYTES;
    return () => { this.#count--; this.#reserved -= GIT_MAX_RESULT_BYTES; };
  }
}
