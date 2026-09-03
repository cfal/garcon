async function readBoundedTextStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  createLimitError?: () => Error,
): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let byteCount = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remainingBytes = maxBytes - byteCount;
      if (next.value.byteLength > remainingBytes) {
        if (createLimitError) throw createLimitError();
        if (remainingBytes > 0) {
          chunks.push(decoder.decode(next.value.subarray(0, remainingBytes), { stream: true }));
          byteCount = maxBytes;
        }
        continue;
      }
      byteCount += next.value.byteLength;
      chunks.push(decoder.decode(next.value, { stream: true }));
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
  return readBoundedTextStream(stream, maxBytes, createLimitError);
}

// Drains the stream while retaining only its bounded prefix.
export function readTextStreamPrefix(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  return readBoundedTextStream(stream, maxBytes);
}
