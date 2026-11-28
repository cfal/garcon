import { parseNativeSeedReceipt } from '../../../../../common/transcript-seed.ts';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function acceptsPlacement(value: unknown): boolean {
  return value === undefined || value === 'user-prefix' || value === 'provider-context';
}

export function acceptsCreateInput(value: unknown): boolean {
  const raw = record(value);
  return raw !== null && typeof raw.agentSessionId === 'string' && typeof raw.prefix === 'string'
    && raw.placement !== undefined && acceptsPlacement(raw.placement)
    && (raw.format === undefined || ['v3-xml', 'v2-xml', 'v1-marker', 'legacy-v0'].some(format => format === raw.format));
}

export function acceptsContext(value: unknown): boolean {
  const raw = record(value);
  return value === null || raw !== null && typeof raw.prefix === 'string'
    && (raw.summaryTruncated === undefined || typeof raw.summaryTruncated === 'boolean');
}

export function acceptsReceipt(value: unknown): boolean {
  return value === null || parseNativeSeedReceipt(value) !== null;
}
