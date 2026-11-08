import type { AgentSettingDescriptor, AgentSettingsEnvelope } from './agent-integration.js';

export type AgentSpeed = 'standard' | 'fast';

// Agents advertise this setting when their runtime can select a service tier.
export const AGENT_SPEED_SETTING = {
  key: 'speed',
  label: 'Speed',
  type: 'enum',
  options: [
    { value: 'standard', label: 'Standard' },
    { value: 'fast', label: 'Fast', description: 'Faster responses with higher usage.' },
  ],
} as const satisfies AgentSettingDescriptor;

export function findAgentSpeedSetting(
  descriptors: readonly AgentSettingDescriptor[],
): AgentSettingDescriptor | undefined {
  return descriptors.find((descriptor) => descriptor.key === AGENT_SPEED_SETTING.key
    && descriptor.type === 'enum'
    && ['standard', 'fast'].every((value) => descriptor.options.some((option) => option.value === value)));
}

export function agentSpeed(settings: AgentSettingsEnvelope): AgentSpeed {
  return settings.values[AGENT_SPEED_SETTING.key] === 'fast' ? 'fast' : 'standard';
}
