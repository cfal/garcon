export interface NodeReplyAuthority {
  readonly signal: AbortSignal;
  validate(): void;
  failed(error: unknown): void;
}

/** Owns reply delivery independently of the handler slot and exposes exact queued-reply cancellation. */
export interface NodeReplyPort {
  enqueue(requestId: number, serialized: string, authority: NodeReplyAuthority): void;
  cancel(requestId: number): void;
  close(): void;
}

/** Preserves synchronous admission and unknown-on-refusal behavior on existing bounded execution writers. */
export function immediateNodeReplies(writer: { send(text: string): boolean; close(): void }): NodeReplyPort {
  return {
    enqueue(_requestId, text, authority) {
      authority.signal.throwIfAborted(); authority.validate(); authority.signal.throwIfAborted();
      writer.send(text);
    },
    cancel() {},
    close: () => writer.close(),
  };
}
