import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types.js';
import type { NewChatPromptDraft } from './new-chat-prompt-draft';

export interface NewChatFormStateOptions {
	modelCatalog: ModelCatalogStore;
	executors?: ExecutorsStore;
	remoteSettings: RemoteSettingsStore;
	get selectableAgentIds(): readonly SessionAgentId[];
	/** Retains the unsent prompt across reseeds. Omitted where the prompt is persisted elsewhere. */
	promptDraft?: NewChatPromptDraft;
}
