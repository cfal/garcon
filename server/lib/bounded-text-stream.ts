export async function readTextStreamWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  createLimitError: () => Error,
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
      byteCount += next.value.byteLength;
      if (byteCount > maxBytes) throw createLimitError();
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}
