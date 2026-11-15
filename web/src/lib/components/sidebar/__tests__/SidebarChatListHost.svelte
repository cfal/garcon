<script lang="ts">
	import { untrack } from 'svelte';
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import type { ExecutorSnapshot } from '$shared/executors';
	import { localExecutor } from '$lib/executors/__tests__/fixtures';
	import SidebarChatList from '../SidebarChatList.svelte';
	import { SidebarOrderController } from '$lib/sidebar/display/sidebar-order-controller.svelte';
	import { chatOrderGroupFor } from '$shared/chat-filter-query';
	import { setAppShell, setModelCatalog } from '$lib/context';
	import { setWorkspaceWindowDndTestContext } from './workspace-window-dnd-test-context.js';
	import {
		DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		type SidebarDisplayOptions,
	} from '../../../sidebar/display/sidebar-display-options';
	import type {
		PersistedChatOrderGroup,
		RelativeChatOrderPlacement,
	} from '$shared/chat-order-contracts';
	import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
	import type { ChatOrderSortKey } from '$shared/chat-order-sort';
	import { workspaceSplitAdmissions } from '$lib/workspace/__tests__/workspace-geometry-test-fixtures.js';

	interface SidebarChatListHostProps {
		chats: ChatSessionRecord[];
		executors?: readonly ExecutorSnapshot[];
		filteredChats?: ChatSessionRecord[];
		searchFilter?: string;
		onNewChat?: () => void;
		selectedChatId?: string | null;
		isMobile?: boolean;
		displayOptions?: Partial<SidebarDisplayOptions>;
		collapsedProjectKeys?: ReadonlySet<string>;
		onToggleProjectCollapsed?: (projectKey: string) => void;
		onQuickMove?: (
			list: PersistedChatOrderGroup,
			chatId: string,
			placement: RelativeChatOrderPlacement,
			onSuccess?: () => void,
			onFailure?: () => void,
		) => void;
		onSortChatOrder?: (sortKey: ChatOrderSortKey) => void;
	}

	let {
		chats,
		executors,
		filteredChats = chats,
		searchFilter = '',
		onNewChat,
		selectedChatId = null,
		isMobile = false,
		displayOptions: displayOptionsInput = {},
		collapsedProjectKeys = new Set<string>(),
		onToggleProjectCollapsed,
		onQuickMove = () => {},
		onSortChatOrder = () => {},
	}: SidebarChatListHostProps = $props();
	const executorStore = untrack(() => setExecutorsTestContext(executors ?? [localExecutor]));

	let viewportRef = $state<HTMLElement | null>(null);
	let displayOptions = $derived({
		...DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		groupingFields: [],
		nestDelegatedChats: false,
		sortMode: 'manual' as const,
		...displayOptionsInput,
	});
	let internalCollapsedKeys = $derived<ReadonlySet<string>>(new Set(collapsedProjectKeys));
	let effectiveCollapsedKeys = $derived(
		onToggleProjectCollapsed ? collapsedProjectKeys : internalCollapsedKeys,
	);

	function handleProjectCollapseToggle(projectKey: string): void {
		if (onToggleProjectCollapsed) {
			onToggleProjectCollapsed(projectKey);
			return;
		}
		const next = new Set(internalCollapsedKeys);
		if (next.has(projectKey)) next.delete(projectKey);
		else next.add(projectKey);
		internalCollapsedKeys = next;
	}

	setAppShell({
		onSidebarRecenterRequested() {
			return () => {};
		},
	} as never);

	setModelCatalog({
		forExecutor() {
			return this;
		},
		supportsFork() {
			return true;
		},
		supportsForkWhileRunning() {
			return false;
		},
		supportsUpdateProjectPath() {
			return true;
		},
	} as never);

	setWorkspaceWindowDndTestContext();
	const projectionInput = $derived({
		allChats: chats,
		matchingChatIds: searchFilter.trim()
			? new Set(filteredChats.map((chat) => chat.id))
			: undefined,
		groupingFields: displayOptions.groupingFields,
		nestDelegatedChats: displayOptions.nestDelegatedChats,
		currentTime: new Date('2025-01-01T03:00:00.000Z'),
		inactivityDuration: displayOptions.inactivityDuration,
		sortMode: displayOptions.sortMode,
		pinnedInsertPosition: displayOptions.pinnedInsertPosition,
		groupNestedProjectPaths: displayOptions.groupNestedProjectPaths,
		collapsedProjectKeys: effectiveCollapsedKeys,
		executorOrder: executorStore.executors.map((executor) => executor.id),
	});
	const reorder = new SidebarOrderController({
		get input() {
			return projectionInput;
		},
		write: (request) =>
			new Promise((resolve, reject) => {
				const chat = chats.find((chat) => chat.id === request.chatId)!;
				if (request.placement.kind !== 'relative') throw new Error('Expected relative move');
				onQuickMove(
					chatOrderGroupFor(chat),
					request.chatId,
					request.placement,
					() => resolve(undefined),
					reject,
				);
			}),
		refresh: async () => true,
		sort: async (key) => {
			onSortChatOrder(key);
			return { changed: false };
		},
		onError: () => {},
	});
</script>

<div
	bind:this={viewportRef}
	data-testid="sidebar-list-viewport"
	style="height:640px; overflow-y:auto;"
>
	<SidebarChatList
		{viewportRef}
		projection={reorder.projection}
		{selectedChatId}
		isLoading={false}
		{isMobile}
		currentTime={new Date('2025-01-01T03:00:00.000Z')}
		{searchFilter}
		{onNewChat}
		{displayOptions}
		onToggleProjectCollapsed={handleProjectCollapseToggle}
		onChatSelect={() => {}}
		onDeleteChat={() => {}}
		onStartRenameChat={() => {}}
		onShowDetails={() => {}}
		onForkChat={() => {}}
		onShareChat={() => {}}
		onTogglePinned={() => {}}
		onToggleArchive={() => {}}
		{reorder}
		{onSortChatOrder}
		newWindowEdges={workspaceSplitAdmissions()}
	/>
</div>
