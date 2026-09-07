<script lang="ts">
	import PreamblesSection from '../PreamblesSection.svelte';
	import { setAppShell, setModelCatalog, setPreambles, setSidebarSearch } from '$lib/context';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte';
	import { PreamblesStore, type PreamblesStoreDeps } from '$lib/preambles/preambles-store.svelte';
	import {
		createModelCatalogStore,
		type AgentMetadata,
	} from '$lib/agents/model-catalog-store.svelte';
	import { createSidebarSearchStore } from '$lib/sidebar/search/sidebar-search-store.svelte.js';
	import { createEmptyAgentSettings } from '$shared/agent-settings';
	import type { PreamblesSnapshot } from '$shared/preambles';
	import { untrack } from 'svelte';

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
		onStore,
	}: {
		snapshot: PreamblesSnapshot;
		deps?: PreamblesStoreDeps;
		onStore?: (store: PreamblesStore) => void;
	} = $props();
	const preambles = new PreamblesStore(untrack(() => deps));
	preambles.applySnapshot(untrack(() => snapshot));
	untrack(() => onStore?.(preambles));
	setAppShell(createAppShellStore());
	const modelCatalog = createModelCatalogStore();
	modelCatalog.agentMetadata = {
		claude: agentMetadata('claude', 'Claude'),
		codex: agentMetadata('codex', 'Codex'),
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
