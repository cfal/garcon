import { TICKET_LIMITS } from '@garcon/common/tickets';
import { ticketBody } from '@garcon/common/ticket-validation';
import { argumentError } from './errors.js';

export function validateTicketStdin(text: string): string {
  try { return ticketBody(text); }
  catch (error) { throw argumentError('stdin must be well-formed UTF-8 text of at most 48 KiB', { cause: error }); }
}

export async function readTicketStdin(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let content = '';
  const onAbort = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > TICKET_LIMITS.bodyBytes) throw argumentError('stdin exceeds 48 KiB');
      content += decoder.decode(chunk.value, { stream: true });
    }
    signal?.throwIfAborted();
    return validateTicketStdin(content + decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    signal?.throwIfAborted();
    throw argumentError('stdin must be well-formed UTF-8 text of at most 48 KiB', { cause: error });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
