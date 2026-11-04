import { createHash } from 'node:crypto';
import type { EffectiveAutomationInput } from '../../../common/automation.js';
import type { Preamble } from '../../../common/preambles.js';
import { stableJsonStringify } from '../../../common/json.js';
import type { AutomationControlLease } from './lifecycle.js';
import { DomainError } from '../../common/domain-error.js';

export interface AutomationInputConstraints {
  readonly control: AutomationControlLease;
  readonly canceled: AbortSignal;
  readonly effective: EffectiveAutomationInput;
  inputPublished: boolean;
}

export function automationContentDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export function automationInputDigest(input: unknown): string {
  return automationContentDigest(stableJsonStringify(input));
}

export function assertAutomationPreambles(expected: EffectiveAutomationInput['preambles'], actual: readonly Preamble[]): void {
  if (expected.length !== actual.length || expected.some((entry, index) =>
    entry.id !== actual[index]?.id || entry.contentDigest !== automationContentDigest(actual[index]!.content))) {
    throw new DomainError('VALIDATION_FAILED', 'Selected preambles changed after automation approval', 409);
  }
}
