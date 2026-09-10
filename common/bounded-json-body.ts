/** Bounds decoded JSON bytes and cancels stalled readers without waiting for stream cleanup. */
export async function readBoundedJsonBody(
  message: Pick<Response, 'headers' | 'body'>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (!message.body) throw invalidBody();
  const reader = message.body.getReader();
  const cancelled = Promise.withResolvers<never>();
  const abort = () => {
    cancelled.reject(signal.reason);
    void reader.cancel().catch(() => {});
  };
  try {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid JSON body byte limit');
    const declared = message.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw invalidBody();
    if (message.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw invalidBody();
    signal.addEventListener('abort', abort, { once: true });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let bytes = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), cancelled.promise]);
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw invalidBody();
      text += decoder.decode(chunk.value, { stream: true });
    }
    // Fetch retains compressed Content-Length after decoding the response body.
    const encoding = message.headers.get('content-encoding');
    if (declared !== null && (!encoding || encoding === 'identity') && Number(declared) !== bytes) throw invalidBody();
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function invalidBody(): TypeError {
  return new TypeError('Expected bounded UTF-8 JSON');
}
