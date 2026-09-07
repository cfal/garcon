<script lang="ts">
	import { untrack } from 'svelte';
	import {
		setAppShell,
		setChatPreambleSelectionInvalidationHub,
		setPreambles,
	} from '$lib/context';
	import { createAppShellStore, type AppShellStore } from '$lib/stores/app-shell.svelte';
	import { PreamblesStore } from '$lib/preambles/preambles-store.svelte';
	import { createChatPreambleSelectionInvalidationHub } from '$lib/preambles/chat-selection-invalidation-hub.js';
	import type {
		PreambleId,
		PreambleSelectionProjection,
		PreamblesSnapshot,
	} from '$shared/preambles';
	import ChatPreambleSelectionPanel from '../ChatPreambleSelectionPanel.svelte';
	import NewChatPreamblePicker from '../NewChatPreamblePicker.svelte';

	let {
		mode = 'panel',
		snapshot,
		draftIds,
		projection = null,
		canonicalProjectPath = '/workspace/project',
		choice = { mode: 'defaults' },
		defaultsIds = draftIds,
		onMove = () => undefined,
		onRemove = () => undefined,
		onAdd = () => undefined,
		onClose = () => undefined,
		onApplyExplicit = () => undefined,
		onResetToDefaults = () => undefined,
		onAppShell,
	}: {
		mode?: 'panel' | 'new-chat';
		snapshot: PreamblesSnapshot;
		draftIds: readonly PreambleId[];
		projection?: PreambleSelectionProjection | null;
		canonicalProjectPath?: string;
		choice?:
			| { mode: 'defaults' }
			| { mode: 'explicit'; orderedPreambleIds: readonly PreambleId[] };
		defaultsIds?: readonly PreambleId[];
		onMove?: (id: PreambleId, direction: 'up' | 'down') => void;
		onRemove?: (id: PreambleId) => void;
		onAdd?: (id: PreambleId) => void;
		onClose?: () => void;
		onApplyExplicit?: (ids: readonly PreambleId[]) => void;
		onResetToDefaults?: () => void;
		onAppShell?: (store: AppShellStore) => void;
	} = $props();

	const appShell = createAppShellStore();
	const preambles = new PreamblesStore();
	preambles.applySnapshot(untrack(() => snapshot));
	untrack(() => onAppShell?.(appShell));
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
		open={true}
		{choice}
		{defaultsIds}
		{projection}
		{canonicalProjectPath}
		{onClose}
		{onApplyExplicit}
		{onResetToDefaults}
	/>
{/if}
