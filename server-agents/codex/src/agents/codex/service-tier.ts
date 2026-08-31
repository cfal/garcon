import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { JsonObject } from '@garcon/common/json';
import { AgentIntegrationError } from '@garcon/server-agent-interface';

export const CODEX_FAST_MODE_SETTING = 'codexFastMode' as const;

export type CodexFastMode = 'on' | 'off';
export type CodexServiceTier = 'priority' | 'default';
export type CodexConfigServiceTier = 'fast' | 'default';

export function codexFastMode(settings: AgentSettingsEnvelope): CodexFastMode {
  return settings.ownerId === 'codex'
    && settings.schemaVersion === 2
    && settings.values[CODEX_FAST_MODE_SETTING] === 'on'
    ? 'on'
    : 'off';
}

export function codexServiceTier(mode: CodexFastMode): CodexServiceTier {
  return mode === 'on' ? 'priority' : 'default';
}

export function codexConfigServiceTier(mode: CodexFastMode): CodexConfigServiceTier {
  return mode === 'on' ? 'fast' : 'default';
}

export function codexFastModeError(
  code: 'INVALID_SETTINGS' | 'PROVIDER_FAILURE' | 'TIMEOUT' | 'UNAVAILABLE',
  message: string,
  retryable: boolean,
  details: JsonObject = {},
): AgentIntegrationError {
  return new AgentIntegrationError(code, message, retryable, {
    provider: 'codex',
    setting: CODEX_FAST_MODE_SETTING,
    ...details,
  });
}

export type CodexServiceTierOperation = 'thread/start' | 'thread/resume' | 'thread/fork';

export function assertEffectiveCodexServiceTier(input: {
  readonly requested: CodexServiceTier;
  readonly effective: string | null | undefined;
  readonly model: string;
  readonly operation: CodexServiceTierOperation;
}): CodexServiceTier {
  if (input.effective === input.requested) return input.requested;
  const details = {
    provider: 'codex',
    setting: CODEX_FAST_MODE_SETTING,
    operation: input.operation,
    requestedServiceTier: input.requested,
    effectiveServiceTier: input.effective ?? 'unconfirmed',
  } as const;
  if (input.requested === 'priority') {
    throw new AgentIntegrationError(
      'INVALID_SETTINGS',
      `Codex Fast mode is unavailable for ${input.model}. Choose Off or a supported model.`,
      false,
      details,
    );
  }
  throw new AgentIntegrationError(
    'PROVIDER_FAILURE',
    'Codex could not confirm Standard processing. No new prompt was sent.',
    true,
    details,
  );
}
