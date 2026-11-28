// Envelope callers pass offsets within a JavaScript string.
export function isEnvelopeOffset(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
}
