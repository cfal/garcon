import { AuthValidationError } from '../../../common/auth.js';
import { DomainError } from '../../common/domain-error.js';

const MAX_BODY_BYTES = 4096;
let activeReaders = 0;

export async function readAuthBody(request: Request): Promise<unknown> {
  const tooLarge = () => new DomainError('AUTH_REQUEST_TOO_LARGE', 'Authentication request is too large.', 413);
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw tooLarge();
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !request.body) {
    throw new AuthValidationError('A JSON body is required.');
  }
  if (activeReaders >= 2) throw new DomainError('AUTH_BUSY', 'Authentication is busy. Try again shortly.', 429);
  activeReaders++;
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
  const cancelled = Promise.withResolvers<never>();
  const abort = () => { cancelled.reject(new AuthValidationError('Authentication request was interrupted.')); void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let finished = false;
  try {
    signal.throwIfAborted();
    let bytes = 0;
    const parts: string[] = [];
    while (true) {
      const chunk = await Promise.race([reader.read(), cancelled.promise]);
      if (chunk.done) { finished = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw tooLarge();
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join(''));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || signal.aborted) {
      throw new AuthValidationError('A complete valid UTF-8 JSON body is required.');
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
    activeReaders--;
  }
}
