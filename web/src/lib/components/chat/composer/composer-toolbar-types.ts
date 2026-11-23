import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
import type { JsonValue } from '$shared/json';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte';

export interface ComposerAgentSettings {
	descriptors: readonly AgentSettingDescriptor[];
	envelope: AgentSettingsEnvelope;
	defaults: AgentSettingsEnvelope;
	onChange: (descriptor: AgentSettingDescriptor, value: JsonValue) => void;
	disabled?: boolean;
}

export interface ComposerExecutor {
	executors: ExecutorsStore;
	executorId: string;
	onSelect: (executorId: string) => void;
}
