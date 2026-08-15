export const GENERATION_PROVIDER_TIMEOUT_MS = 110_000;
const GENERATION_TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

export function createGenerationRequestSignal(externalSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(GENERATION_PROVIDER_TIMEOUT_MS);
  return externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;
}

export function isGenerationTimeoutError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (!(current instanceof Error)) return false;
    const name = current.name.toLowerCase();
    if (name === 'aborterror' || name === 'timeouterror') return true;
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string' && GENERATION_TIMEOUT_CODES.has(code.toUpperCase())) return true;
    current = current.cause;
  }
  return false;
}
