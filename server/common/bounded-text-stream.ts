// Drains the stream while retaining only its bounded prefix. Notifies on the first discarded byte.
export async function readTextStreamPrefix(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onTruncate?: () => void,
): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let remainingBytes = maxBytes;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = value;
      if (chunk.byteLength > remainingBytes) {
        onTruncate?.();
        onTruncate = undefined;
        if (remainingBytes <= 0) continue;
        chunk = chunk.subarray(0, remainingBytes);
        remainingBytes = 0;
      } else {
        remainingBytes -= chunk.byteLength;
      }
      chunks.push(decoder.decode(chunk, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

export function readTextStreamWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  createLimitError: () => Error,
): Promise<string> {
  return readTextStreamPrefix(stream, maxBytes, () => { throw createLimitError(); });
}
