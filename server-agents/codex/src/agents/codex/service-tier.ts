import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import { AgentIntegrationError } from '@garcon/server-agent-interface';

export const CODEX_SPEED_SETTING = {
  key: 'speed', label: 'Speed', labelKey: 'speed', type: 'enum',
  options: [
    { value: 'standard', label: 'Standard', description: 'Normal speed and usage.' },
    { value: 'fast', label: 'Fast', description: 'Faster responses with increased usage, where available.' },
    { value: 'ultrafast', label: 'Ultrafast', description: 'Fastest responses with higher usage. Availability depends on the model and workspace.' },
  ],
} as const satisfies AgentSettingDescriptor;

export type CodexSpeed = typeof CODEX_SPEED_SETTING.options[number]['value'];
const TIERS = { standard: 'default', fast: 'priority', ultrafast: 'ultrafast' } as const;
export type CodexServiceTier = typeof TIERS[CodexSpeed];

export function codexSpeed(settings: AgentSettingsEnvelope): CodexSpeed {
  const speed = settings.values.speed;
  if (speed === undefined) return 'standard';
  if (speed === 'standard' || speed === 'fast' || speed === 'ultrafast') return speed;
  throw new AgentIntegrationError('INVALID_SETTINGS', 'Invalid value for setting speed', false);
}

export function codexServiceTier(speed: CodexSpeed = 'standard'): CodexServiceTier {
  return TIERS[speed];
}

export function normalizeCodexServiceTier(tier: string | null): string {
  return tier === 'fast' ? 'priority' : tier ?? 'default';
}

export function unavailableTier(tier: CodexServiceTier, model: string): AgentIntegrationError {
  const label = CODEX_SPEED_SETTING.options.find(({ value }) => TIERS[value] === tier)!.label;
  return new AgentIntegrationError('INVALID_SETTINGS',
    `Codex ${label} speed is unavailable for ${model} on this executor. Check the model and workspace settings or choose Standard.`, false);
}

export function assertEffectiveTier(requested: CodexServiceTier, effective: string | null, model: string): void {
  if (normalizeCodexServiceTier(effective) !== requested) throw unavailableTier(requested, model);
}
