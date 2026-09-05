import type { Preamble, PreambleErrorCode } from '../../common/preambles.js';
import { preambleCatalogCompositionViolation } from './catalog-budget.js';

export class PreambleDomainError extends Error {
  constructor(
    readonly code: PreambleErrorCode,
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'PreambleDomainError';
  }
}

export function assertPreambleCatalogComposition(preambles: readonly Preamble[]): void {
  const violation = preambleCatalogCompositionViolation(preambles);
  if (!violation) return;
  const scope = violation.projectPath === null ? 'the global scope' : violation.projectPath;
  if (violation.kind === 'file-context-separator') {
    throw new PreambleDomainError(
      'PREAMBLE_VALIDATION_FAILED',
      `Combined matching preambles contain a reserved separator at ${scope}`,
      400,
    );
  }
  throw new PreambleDomainError(
    'PREAMBLE_COMBINED_LIMIT_EXCEEDED',
    `Combined matching preambles exceed the maximum length at ${scope}`,
    422,
  );
}
