import {
  AgentIntegrationError,
  isUnsupportedSingleQueryThinkingMode as checksThinkingMode,
} from '../../../server-agents/interface/src/errors.ts';

// Nominal error instances cannot be decoded from class names by the unit recorder.
export function isUnsupportedSingleQueryThinkingMode(
  code: ConstructorParameters<typeof AgentIntegrationError>[0],
  details?: ConstructorParameters<typeof AgentIntegrationError>[3],
): boolean {
  return checksThinkingMode(new AgentIntegrationError(code, 'synthetic', false, details));
}
