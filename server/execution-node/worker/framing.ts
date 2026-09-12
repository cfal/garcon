export const NODE_WORKER_FRAME_HEADER_BYTES = 4;

export class NodeWorkerTransportError extends Error {
  constructor(readonly code: 'NODE_WORKER_PROTOCOL' | 'NODE_WORKER_CLOSED' | 'NODE_WORKER_CAPACITY' | 'NODE_WORKER_TIMEOUT') {
    super(code);
    this.name = 'NodeWorkerTransportError';
  }
}

export function encodeNodeWorkerFrame(text: string, maxFrameBytes: number): Uint8Array {
  const length = Buffer.byteLength(text);
  if (!length || length > maxFrameBytes) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
  const bytes = new Uint8Array(NODE_WORKER_FRAME_HEADER_BYTES + length);
  new DataView(bytes.buffer).setUint32(0, length);
  bytes.set(Buffer.from(text), NODE_WORKER_FRAME_HEADER_BYTES);
  return bytes;
}

/** Reads one bounded frame at a time; a partial EOF never becomes a successful message. */
export async function* readNodeWorkerFrames(
  source: ReadableStream<Uint8Array>, maxFrameBytes: number, signal: AbortSignal,
  read?: () => void,
): AsyncGenerator<string> {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 0xffff_ffff) throw new TypeError('Invalid worker frame limit');
  signal.throwIfAborted();
  const reader = source.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const header = new Uint8Array(NODE_WORKER_FRAME_HEADER_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let body: Uint8Array | null = null;
  let offset = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        if (offset || body) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
        return;
      }
      read?.();
      let consumed = 0;
      while (consumed < value.byteLength) {
        signal.throwIfAborted();
        const target = body ?? header;
        const count = Math.min(target.byteLength - offset, value.byteLength - consumed);
        target.set(value.subarray(consumed, consumed + count), offset);
        offset += count;
        consumed += count;
        if (offset !== target.byteLength) continue;
        offset = 0;
        if (!body) {
          const length = new DataView(header.buffer).getUint32(0);
          if (!length || length > maxFrameBytes) throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
          body = new Uint8Array(length);
        } else {
          let text: string;
          try { text = decoder.decode(body); }
          catch { throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL'); }
          finally { body.fill(0); body = null; }
          yield text;
        }
      }
    }
  } finally {
    body?.fill(0);
    signal.removeEventListener('abort', cancel);
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}
