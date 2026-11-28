// A module whose exports are values and function declarations that read them.
import { join } from './functions.js';

export const VERSION = 3;
export const SEPARATORS = { comma: ',', dot: '.' } as const;
export const LIMIT = 2;

export function versionLabel(): string {
  return `v${VERSION}`;
}

export function limited(parts: string[]): string {
  return join(parts.slice(0, LIMIT), SEPARATORS.comma);
}

export function count(parts: string[]): number {
  return parts.length / LIMIT;
}
