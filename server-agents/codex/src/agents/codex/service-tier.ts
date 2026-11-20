import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import { AgentIntegrationError } from '@garcon/server-agent-interface';

const SPEED_OPTION_BY_TIER = {
  default: { value: 'standard', label: 'Standard', description: 'Normal speed and usage.' },
  priority: { value: 'fast', label: 'Fast', description: 'Faster responses with increased usage, where available.' },
  ultrafast: { value: 'ultrafast', label: 'Ultrafast', description: 'Fastest responses with higher usage. Availability depends on the model and workspace.' },
} as const;

export const CODEX_SPEED_SETTING = {
  key: 'speed', label: 'Speed', labelKey: 'speed', type: 'enum',
  options: Object.values(SPEED_OPTION_BY_TIER),
} as const satisfies AgentSettingDescriptor;

export type CodexServiceTier = keyof typeof SPEED_OPTION_BY_TIER;
export type CodexSpeed = typeof SPEED_OPTION_BY_TIER[CodexServiceTier]['value'];

const TIER_BY_SPEED = {
  standard: 'default',
  fast: 'priority',
  ultrafast: 'ultrafast',
} satisfies Record<CodexSpeed, CodexServiceTier>;

export function codexSpeed(settings: AgentSettingsEnvelope): CodexSpeed {
  const speed = settings.values.speed;
  if (speed === undefined) return 'standard';
  const option = CODEX_SPEED_SETTING.options.find(({ value }) => value === speed);
  if (option) return option.value;
  throw new AgentIntegrationError('INVALID_SETTINGS', 'Invalid value for setting speed', false);
}

export function codexServiceTier(speed: CodexSpeed = 'standard'): CodexServiceTier {
  return TIER_BY_SPEED[speed];
}

export function normalizeCodexServiceTier(tier: string | null): string {
  return tier === 'fast' ? 'priority' : tier ?? 'default';
}

export function unavailableTier(tier: CodexServiceTier, model: string): AgentIntegrationError {
  const { label } = SPEED_OPTION_BY_TIER[tier];
  return new AgentIntegrationError('INVALID_SETTINGS',
    `Codex ${label} speed is unavailable for ${model} on this executor. Check the model and workspace settings or choose Standard.`, false);
}

export function assertEffectiveTier(requested: CodexServiceTier, effective: string | null, model: string): void {
  if (normalizeCodexServiceTier(effective) !== requested) throw unavailableTier(requested, model);
}
