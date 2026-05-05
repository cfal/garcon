// Iterates server-sent event data payloads from a fetch response body.

export async function readSseDataEvents(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        emitDataLine(line, onData);
      }
    }

    buffer += decoder.decode();
    emitDataLine(buffer, onData);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function emitDataLine(line: string, onData: (data: string) => void): void {
  const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!normalized.startsWith('data:')) return;
  onData(normalized.slice(5).trim());
}
