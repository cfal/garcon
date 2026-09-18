import {
  AgentCallError,
  createAgentResourceRef,
  isAgentResourceRef,
  type AgentResourceRef,
  type AgentResourceScope,
} from '@garcon/server-agent-interface';

export class AgentResourceTable<K extends string, T> {
  readonly #entries = new Map<string, T>();

  constructor(
    readonly scope: AgentResourceScope,
    readonly kind: K,
    readonly limit = 4096,
  ) {}

  add(value: T): AgentResourceRef<K> {
    const ref = createAgentResourceRef(this.scope, this.kind);
    this.bind(ref, value);
    return ref;
  }

  bind(ref: AgentResourceRef<K>, value: T): void {
    this.#validate(ref);
    if (this.#entries.has(ref.id)) throw new AgentCallError('rejected', 'Resource is already bound', 'STALE_RESOURCE');
    if (this.#entries.size >= this.limit) throw new AgentCallError('rejected', 'Resource budget exhausted');
    this.#entries.set(ref.id, value);
  }

  get(ref: AgentResourceRef<K>): T {
    this.#validate(ref);
    const value = this.#entries.get(ref.id);
    if (value === undefined) throw new AgentCallError('rejected', 'Resource has retired', 'STALE_RESOURCE');
    return value;
  }

  take(ref: AgentResourceRef<K>): T {
    const value = this.get(ref);
    this.#entries.delete(ref.id);
    return value;
  }

  delete(ref: AgentResourceRef<K>): void {
    this.#validate(ref);
    this.#entries.delete(ref.id);
  }

  removeWhere(predicate: (value: T) => boolean): void {
    for (const [id, value] of this.#entries) {
      if (predicate(value)) this.#entries.delete(id);
    }
  }

  clear(): void { this.#entries.clear(); }

  #validate(ref: unknown): void {
    if (!isAgentResourceRef(ref, this.kind, this.scope)) {
      throw new AgentCallError('rejected', 'Resource belongs to another execution scope', 'STALE_RESOURCE');
    }
  }
}
