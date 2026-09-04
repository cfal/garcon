import crypto from 'node:crypto';
import { PREAMBLE_COMBINED_MAX_LENGTH } from './preambles.js';

export interface PreamblePrefixReceipt {
  readonly format: 'preamble-v1';
  readonly codeUnitLength: number;
  readonly sha256: string;
}

export interface PreamblePrefixApplication {
  readonly prefix: string;
  readonly receipt: PreamblePrefixReceipt;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PREAMBLE_INPUT_BOUNDARY = '<!-- garcon-preamble-input --> ';
export const PREAMBLE_OPEN_PREFIX = '<garcon-preambles ';

export function renderPreamblePrefix(contents: readonly string[]): string {
  if (contents.length === 0) return '';
  return [
    '<garcon-preambles version="1">',
    contents.join('\n\n'),
    `</garcon-preambles>\n\n${PREAMBLE_INPUT_BOUNDARY}`,
  ].join('\n');
}

export function createPreamblePrefix(input: {
  readonly contents: readonly string[];
}): PreamblePrefixApplication | null {
  if (input.contents.length === 0) return null;
  const prefix = renderPreamblePrefix(input.contents);
  if (prefix.length > PREAMBLE_COMBINED_MAX_LENGTH) {
    throw new RangeError('Combined preamble content exceeds the maximum length');
  }
  return {
    prefix,
    receipt: {
      format: 'preamble-v1',
      codeUnitLength: prefix.length,
      sha256: crypto.createHash('sha256').update(prefix).digest('hex'),
    },
  };
}

export function parsePreamblePrefixReceipt(value: unknown): PreamblePrefixReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some((key) => !['format', 'codeUnitLength', 'sha256'].includes(key))
    || raw.format !== 'preamble-v1'
    || typeof raw.sha256 !== 'string'
    || !SHA256_PATTERN.test(raw.sha256)
    || !Number.isSafeInteger(raw.codeUnitLength)
    || (raw.codeUnitLength as number) < 1
    || (raw.codeUnitLength as number) > PREAMBLE_COMBINED_MAX_LENGTH
  ) return null;
  return {
    format: raw.format,
    codeUnitLength: raw.codeUnitLength as number,
    sha256: raw.sha256,
  };
}
