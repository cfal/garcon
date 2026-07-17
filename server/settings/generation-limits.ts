export const GENERATION_PROVIDER_TIMEOUT_MS = 110_000;

export function createGenerationRequestSignal(externalSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(GENERATION_PROVIDER_TIMEOUT_MS);
  return externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;
}
