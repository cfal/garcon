import crypto from 'node:crypto';
import { PREAMBLE_COMBINED_MAX_LENGTH } from './preambles.js';

export interface PreamblePrefixReceipt {
  readonly format: 'preamble-v1';
  readonly applicationKey: string;
  readonly codeUnitLength: number;
  readonly sha256: string;
}

export interface PreamblePrefixApplication {
  readonly prefix: string;
  readonly receipt: PreamblePrefixReceipt;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const PREAMBLE_OPEN_PREFIX = '<garcon-preambles ';

export function preambleApplicationKey(viewId: string, clientMessageId: string): string {
  return crypto.createHash('sha256')
    .update('garcon:preamble-application:v1\0')
    .update(viewId)
    .update('\0')
    .update(clientMessageId)
    .digest('hex');
}

export function renderPreamblePrefix(applicationKey: string, contents: readonly string[]): string {
  if (!SHA256_PATTERN.test(applicationKey)) throw new TypeError('Preamble application key is invalid');
  if (contents.length === 0) return '';
  return [
    `<garcon-preambles version="1" application="${applicationKey}">`,
    contents.join('\n\n'),
    '</garcon-preambles>\n\n',
  ].join('\n');
}

export function createPreamblePrefix(input: {
  readonly viewId: string;
  readonly clientMessageId: string;
  readonly contents: readonly string[];
}): PreamblePrefixApplication | null {
  if (input.contents.length === 0) return null;
  const applicationKey = preambleApplicationKey(input.viewId, input.clientMessageId);
  const prefix = renderPreamblePrefix(applicationKey, input.contents);
  if (prefix.length > PREAMBLE_COMBINED_MAX_LENGTH) {
    throw new RangeError('Combined preamble content exceeds the maximum length');
  }
  return {
    prefix,
    receipt: {
      format: 'preamble-v1',
      applicationKey,
      codeUnitLength: prefix.length,
      sha256: crypto.createHash('sha256').update(prefix).digest('hex'),
    },
  };
}

export function parsePreamblePrefixReceipt(value: unknown): PreamblePrefixReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some((key) => !['format', 'applicationKey', 'codeUnitLength', 'sha256'].includes(key))
    || raw.format !== 'preamble-v1'
    || typeof raw.applicationKey !== 'string'
    || !SHA256_PATTERN.test(raw.applicationKey)
    || typeof raw.sha256 !== 'string'
    || !SHA256_PATTERN.test(raw.sha256)
    || !Number.isSafeInteger(raw.codeUnitLength)
    || (raw.codeUnitLength as number) < 1
    || (raw.codeUnitLength as number) > PREAMBLE_COMBINED_MAX_LENGTH
  ) return null;
  return {
    format: raw.format,
    applicationKey: raw.applicationKey,
    codeUnitLength: raw.codeUnitLength as number,
    sha256: raw.sha256,
  };
}
