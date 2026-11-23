import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import { buildPermissionOptions, buildThinkingOptions } from '$lib/chat/composer/composer-controls';
import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte';
import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types';
import { buildModelSelectorRecents } from '$lib/components/model-selector/model-selector-recents';
import type { ModelSelectorChange } from '$lib/components/model-selector/model-selector-types';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import type { ComposerToolbarSettings } from '../composer/composer-toolbar-types';

export function newChatToolbarSettings({
	form,
	modelCatalog,
	remoteSettings,
	getSelectableAgentIds,
	onModelChange,
}: {
	form: NewChatFormState;
	modelCatalog: ModelCatalogStore;
	remoteSettings: RemoteSettingsStore;
	getSelectableAgentIds: (executorId: string) => readonly SessionAgentId[];
	onModelChange: (next: ModelSelectorChange) => void;
}): ComposerToolbarSettings {
	return {
		permission: {
			options: buildPermissionOptions(form.permissionModes),
			selected: form.permissionMode,
			onSelect: (mode) => form.setPermissionMode(mode),
		},
		effort: {
			options: buildThinkingOptions(form.thinkingModes, form.modelValue),
			selected: form.thinkingMode,
			onSelect: (mode) => form.setThinkingMode(mode),
		},
		agentSettings: {
			descriptors: form.agentSettingDescriptors,
			envelope: form.agentSettings,
			defaults: modelCatalog.forExecutor(form.executorId).getDefaultAgentSettings(form.agentId),
			onChange: (descriptor, value) => form.setAgentSetting(descriptor, value),
		},
		model: {
			mode: { agent: 'select', source: 'select', surface: 'composer' },
			value: {
				executorId: form.executorId,
				agentId: form.agentId,
				model: form.modelValue,
				...form.modelSelectionTarget,
			},
			getRecents: (executorId) => buildModelSelectorRecents(
				modelCatalog.forExecutor(executorId),
				remoteSettings.snapshot?.recentAgentSettings ?? [],
			),
			preferRecentsOnOpen: true,
			getSelectableAgentIds,
			onChange: onModelChange,
		},
	};
}
