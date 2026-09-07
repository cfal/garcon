<script lang="ts">
	import { untrack } from 'svelte';
	import { setAppShell, setChatPreambleSelectionInvalidationHub, setPreambles } from '$lib/context';
	import { createAppShellStore, type AppShellStore } from '$lib/stores/app-shell.svelte';
	import { PreamblesStore } from '$lib/preambles/preambles-store.svelte';
	import { createChatPreambleSelectionInvalidationHub } from '$lib/preambles/chat-selection-invalidation-hub.js';
	import type { PreambleSelectionPreviewResponse } from '$lib/api/chat-preambles.js';
	import type {
		PreambleId,
		PreambleSelectionProjection,
		PreamblesSnapshot,
	} from '$shared/preambles';
	import ChatPreambleSelectionPanel from '../ChatPreambleSelectionPanel.svelte';
	import NewChatPreamblePicker from '../NewChatPreamblePicker.svelte';

	let {
		mode = 'panel',
		pickerOpen = true,
		snapshot,
		loadPreambles,
		draftIds,
		projection = null,
		canonicalProjectPath = '/workspace/project',
		choice = { mode: 'defaults' },
		defaultsIds = draftIds,
		previewLoading = false,
		canLoadAutomaticPreview = true,
		onMove = () => undefined,
		onRemove = () => undefined,
		onAdd = () => undefined,
		onClose = () => undefined,
		onApplyExplicit = () => undefined,
		onApplyDefaults = () => undefined,
		onLoadAutomaticPreview = async () => {
			throw new Error('No automatic preview configured');
		},
		onRefreshPreview = () => undefined,
		onAppShell,
		onPreambles,
	}: {
		mode?: 'panel' | 'new-chat';
		pickerOpen?: boolean;
		snapshot: PreamblesSnapshot | null;
		loadPreambles?: () => Promise<PreamblesSnapshot>;
		draftIds: readonly PreambleId[];
		projection?: PreambleSelectionProjection | null;
		canonicalProjectPath?: string;
		choice?: { mode: 'defaults' } | { mode: 'explicit'; orderedPreambleIds: readonly PreambleId[] };
		defaultsIds?: readonly PreambleId[];
		previewLoading?: boolean;
		canLoadAutomaticPreview?: boolean;
		onMove?: (id: PreambleId, direction: 'up' | 'down') => void;
		onRemove?: (id: PreambleId) => void;
		onAdd?: (id: PreambleId) => void;
		onClose?: () => void;
		onApplyExplicit?: (ids: readonly PreambleId[]) => void;
		onApplyDefaults?: () => void;
		onLoadAutomaticPreview?: () => Promise<PreambleSelectionPreviewResponse>;
		onRefreshPreview?: () => void | Promise<void>;
		onAppShell?: (store: AppShellStore) => void;
		onPreambles?: (store: PreamblesStore) => void;
	} = $props();

	const appShell = createAppShellStore();
	const initialLoadPreambles = untrack(() => loadPreambles);
	const initialSnapshot = untrack(() => snapshot);
	const preambles = new PreamblesStore(initialLoadPreambles ? { get: initialLoadPreambles } : {});
	if (initialSnapshot !== null) preambles.applySnapshot(initialSnapshot);
	untrack(() => onAppShell?.(appShell));
	untrack(() => onPreambles?.(preambles));
	setAppShell(appShell);
	setPreambles(preambles);
	setChatPreambleSelectionInvalidationHub(createChatPreambleSelectionInvalidationHub());
</script>

{#if mode === 'panel'}
	<ChatPreambleSelectionPanel
		{draftIds}
		{projection}
		{canonicalProjectPath}
		{onMove}
		{onRemove}
		{onAdd}
	/>
{:else}
	<NewChatPreamblePicker
		open={pickerOpen}
		{choice}
		{defaultsIds}
		{previewLoading}
		{canLoadAutomaticPreview}
		{projection}
		{canonicalProjectPath}
		{onClose}
		{onApplyExplicit}
		{onApplyDefaults}
		{onLoadAutomaticPreview}
		{onRefreshPreview}
	/>
{/if}
