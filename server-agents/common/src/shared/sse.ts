// Iterates server-sent event data payloads from a fetch response body.
import type { NativeCleanupObserver } from '../execution/native-cleanup.js';

export async function readSseDataEvents(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
  cleanup: NativeCleanupObserver | null = null,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let readFailure: { error: unknown } | null = null;

  const emitEvent = () => {
    if (dataLines.length === 0) return;
    onData(dataLines.join('\n'));
    dataLines = [];
  };

  const processLine = (line: string) => {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (normalized === '') {
      emitEvent();
      return;
    }
    if (normalized === 'data') {
      dataLines.push('');
      return;
    }
    if (!normalized.startsWith('data:')) return;
    const value = normalized.slice(5);
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
  };

  try {
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await reader.read(); }
      catch (error) { readFailure = { error }; throw error; }
      const { done, value } = chunk;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        processLine(line);
      }
    }

    buffer += decoder.decode();
    if (buffer) processLine(buffer);
    emitEvent();
  } finally {
    await reader.cancel().catch((error: unknown) => {
      // Cancelling an errored stream repeats its stored read error without invoking underlying cleanup.
      if (!readFailure || !Object.is(error, readFailure.error)) cleanup?.failed(error);
    });
    if (cleanup) reader.releaseLock();
  }
}
