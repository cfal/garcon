import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
import { areAgentSettingsCompatible } from '$shared/agent-settings';

export type SettingsCompatibility = 'loading' | 'compatible' | 'incompatible';

export function resolveSettingsPresentation(
	catalog: {
		readonly isValidated: boolean;
		getDefaultAgentSettings(agentId: string): AgentSettingsEnvelope | null;
		getAgentSettingsDescriptors(agentId: string): readonly AgentSettingDescriptor[];
	},
	agentId: string,
	saved: AgentSettingsEnvelope | null | undefined,
): { envelope: AgentSettingsEnvelope | null; compatibility: SettingsCompatibility } {
	const defaults = catalog.getDefaultAgentSettings(agentId);
	const envelope = saved ?? defaults;
	if (!catalog.isValidated || !defaults) return { envelope, compatibility: 'loading' };
	return {
		envelope,
		compatibility: envelope && areAgentSettingsCompatible(envelope, defaults, catalog.getAgentSettingsDescriptors(agentId))
			? 'compatible' : 'incompatible',
	};
}
