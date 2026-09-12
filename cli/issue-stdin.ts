import { ISSUE_LIMITS } from '@garcon/common/issues';
import { issueBody } from '@garcon/common/issue-validation';
import { argumentError } from './errors.js';

export function validateIssueStdin(text: string): string {
  try { return issueBody(text); }
  catch (error) { throw argumentError('stdin must be well-formed UTF-8 text of at most 48 KiB', { cause: error }); }
}

export async function readIssueStdin(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<string> {
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
      if (bytes > ISSUE_LIMITS.bodyBytes) throw argumentError('stdin exceeds 48 KiB');
      content += decoder.decode(chunk.value, { stream: true });
    }
    signal?.throwIfAborted();
    return validateIssueStdin(content + decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    signal?.throwIfAborted();
    throw argumentError('stdin must be well-formed UTF-8 text of at most 48 KiB', { cause: error });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
