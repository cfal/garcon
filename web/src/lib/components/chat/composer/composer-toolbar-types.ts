import type { ComponentProps } from 'svelte';
import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
import type { JsonValue } from '$shared/json';
import type { ComposerModeOption } from '$lib/chat/composer/composer-controls';
import type ComposerModelSelector from '$lib/components/model-selector/ComposerModelSelector.svelte';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import type { PermissionMode, ThinkingMode } from '$lib/types/chat';

export interface ComposerAgentSettings {
	descriptors: readonly AgentSettingDescriptor[];
	envelope: AgentSettingsEnvelope;
	defaults: AgentSettingsEnvelope;
	onChange?: (descriptor: AgentSettingDescriptor, value: JsonValue) => void;
}

export interface ComposerModeSelection<T extends string> {
	options: ComposerModeOption<T>[];
	selected: T;
	onSelect: (value: T) => void;
}

export interface ComposerToolbarSettings {
	permission: ComposerModeSelection<PermissionMode>;
	effort: ComposerModeSelection<ThinkingMode>;
	agentSettings?: ComposerAgentSettings;
	model?: Pick<
		ComponentProps<typeof ComposerModelSelector>,
		| 'value'
		| 'mode'
		| 'onChange'
		| 'getRecents'
		| 'preferRecentsOnOpen'
		| 'getSelectableAgentIds'
	>;
	executor?: {
		executors: ExecutorsStore;
		executorId: string;
		onSelect: (executorId: string) => void;
	};
}
