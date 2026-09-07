<script lang="ts">
	import PreamblesSection from '../PreamblesSection.svelte';
	import {
		setAppShell,
		setLocalSettings,
		setModelCatalog,
		setPreambles,
		setSidebarSearch,
	} from '$lib/context';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import { PreamblesStore, type PreamblesStoreDeps } from '$lib/preambles/preambles-store.svelte';
	import {
		createModelCatalogStore,
		type AgentMetadata,
	} from '$lib/agents/model-catalog-store.svelte';
	import { createSidebarSearchStore } from '$lib/sidebar/search/sidebar-search-store.svelte.js';
	import { createEmptyAgentSettings } from '$shared/agent-settings';
	import {
		DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
	} from '$shared/agents';
	import type { PreamblesSnapshot } from '$shared/preambles';
	import { onDestroy, untrack } from 'svelte';

	function agentMetadata(id: string, label: string): AgentMetadata {
		return {
			id,
			label,
			supportsCompact: false,
			supportsFork: false,
			supportsForkAtMessage: false,
			supportsForkWhileRunning: false,
			supportsUpdateProjectPath: false,
			supportsSteering: false,
			supportsGoals: false,
			supportsImages: false,
			fileAttachmentMimeTypes: [],
			acceptsApiProviderEndpoints: false,
			supportedProtocols: [],
			authLoginSupported: false,
			supportedPermissionModes: [],
			supportedThinkingModes: [],
			settings: [],
			defaultSettings: createEmptyAgentSettings(id),
			defaultModel: '',
		};
	}

	let {
		snapshot,
		deps = {},
		allowDirectChats = false,
		onStore,
	}: {
		snapshot: PreamblesSnapshot;
		deps?: PreamblesStoreDeps;
		allowDirectChats?: boolean;
		onStore?: (store: PreamblesStore) => void;
	} = $props();
	const preambles = new PreamblesStore(untrack(() => deps));
	preambles.applySnapshot(untrack(() => snapshot));
	untrack(() => onStore?.(preambles));
	setAppShell(createAppShellStore());
	const localSettings = createLocalSettingsStore();
	localSettings.allowDirectChats = untrack(() => allowDirectChats);
	setLocalSettings(localSettings);
	onDestroy(() => localSettings.destroy());
	const modelCatalog = createModelCatalogStore();
	modelCatalog.agentMetadata = {
		claude: agentMetadata('claude', 'Claude'),
		codex: agentMetadata('codex', 'Codex'),
		[DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID]: agentMetadata(
			DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
			'Direct Chat Completions',
		),
		[DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID]: agentMetadata(
			DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
			'Direct Responses',
		),
		[DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID]: agentMetadata(
			DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
			'Direct Anthropic',
		),
	};
	setModelCatalog(modelCatalog);
	setPreambles(preambles);
	setSidebarSearch(
		createSidebarSearchStore({
			getChats: () => [],
			getSelectedChatId: () => null,
			getTranscriptSearchEnabled: () => false,
			getSearchResultSort: () => 'relevance',
			notifyError: () => undefined,
		}),
	);
</script>

<PreamblesSection active={true} />
