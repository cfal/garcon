<script lang="ts">
	import { onMount } from 'svelte';
	import SidebarContent from './SidebarContent.svelte';
	import SidebarSearchDock from './SidebarSearchDock.svelte';
	import SidebarSelectionBar from './SidebarSelectionBar.svelte';
	import SidebarChatDialogs from './SidebarChatDialogs.svelte';
	import SidebarProjectPathDialog from './SidebarProjectPathDialog.svelte';
	import SidebarTagDialog from './SidebarTagDialog.svelte';
	import SidebarSearchDialog from './SidebarSearchDialog.svelte';
	import SavedSearchManagerDialog from './SavedSearchManagerDialog.svelte';
	import SavedSearchEditorDialog from './SavedSearchEditorDialog.svelte';
	import ShareChatDialog from '$lib/components/chat/ShareChatDialog.svelte';
	import {
		getAppShell,
		getNotifications,
		getReadReceiptOutbox,
		getSidebarSearch,
	} from '$lib/context';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatOrderList, ReorderQuickTarget } from '$lib/api/chats.js';
	import { createPerListWriteQueue } from './reorder-write-queue';
	import { SidebarController, type SidebarBulkAction } from './sidebar-controller.svelte';
	import { SidebarDialogsState } from './sidebar-dialogs-state.svelte';
	import { ChatSelectionStore } from '$lib/stores/chat-selection.svelte';
	import { addTagToQuery } from './sidebar-search';
	import type { SavedChatSearch } from '$lib/api/settings';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';

	interface QuickMoveWrite {
		list: ChatOrderList;
		chatId: string;
		target: ReorderQuickTarget;
		onSuccess?: () => void;
		onFailure?: () => void;
	}

	interface SidebarProps {
		chats: ChatSessionRecord[];
		selectedChatId: string | null;
		isLoading: boolean;
		isMobile?: boolean;
		onChatSelect: (chatId: string) => void;
		onNewChat: () => void;
		onChatDelete?: (chatId: string) => void;
		/** Applies the optimistic local removal (store + navigation) a
		 *  ChatSessionDeletedWsMessage would trigger, without waiting for
		 *  the server. Used by bulk delete so the list updates instantly. */
		onLocallyDeleteChat?: (chatId: string) => void;
		onQuietRefresh: () => Promise<void> | void;
		onReloadChat?: (chatId: string) => Promise<void> | void;
		onChatRenamed?: (chatId: string, newTitle: string) => void;
		onChatProjectPathUpdated?: (chatId: string, projectPath: string) => void;
		onShowSettings: () => void;
	}

	let {
		chats,
		selectedChatId,
		isLoading,
		isMobile = false,
		onChatSelect,
		onNewChat,
		onChatDelete,
		onLocallyDeleteChat,
		onQuietRefresh,
		onReloadChat,
		onChatRenamed,
		onChatProjectPathUpdated,
		onShowSettings,
	}: SidebarProps = $props();
	const appShell = getAppShell();
	const notifications = getNotifications();
	const readReceiptOutbox = getReadReceiptOutbox();
	const sidebarSearch = getSidebarSearch();
	const controller = new SidebarController({
		get onQuietRefresh() {
			return onQuietRefresh;
		},
	});

	const selection = new ChatSelectionStore();
	const dialogs = new SidebarDialogsState();
	const MINUTE_MS = 60_000;

	// Sidebar UI state.
	let isBulkOperating = $state(false);
	let currentTime = $state(new Date());
	let isMarkingAllRead = $state(false);

	let visibleUnreadChatIds = $derived.by(() =>
		sidebarSearch.filteredChats
			.filter((chat) => chat.isUnread && Boolean(chat.lastActivityAt))
			.map((chat) => chat.id),
	);

	function millisecondsUntilNextMinute(nowMs = Date.now()): number {
		const elapsedInMinute = nowMs % MINUTE_MS;
		return elapsedInMinute === 0 ? MINUTE_MS : MINUTE_MS - elapsedInMinute;
	}

	// Refreshes relative timestamp labels on minute boundaries.
	$effect(() => {
		let intervalId: ReturnType<typeof setInterval> | null = null;

		const refreshCurrentTime = () => {
			currentTime = new Date();
		};

		const timeoutId = setTimeout(() => {
			refreshCurrentTime();
			intervalId = setInterval(refreshCurrentTime, MINUTE_MS);
		}, millisecondsUntilNextMinute());

		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') refreshCurrentTime();
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			clearTimeout(timeoutId);
			if (intervalId) clearInterval(intervalId);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	});

	function handleChatClick(chatId: string) {
		onChatSelect(chatId);
	}

	function reportActionFailure(logMessage: string, userMessage: string, error: unknown): void {
		console.error(logMessage, error);
		notifications.error(userMessage);
	}

	async function handleTogglePinned(chatId: string) {
		const chat = chats.find((s) => s.id === chatId);
		const wasPinned = chat?.isPinned === true;
		try {
			await controller.togglePinned(chatId);
			if (!wasPinned && selectedChatId === chatId) {
				appShell.requestSidebarRecenterToSelected();
			}
		} catch (error) {
			reportActionFailure('Failed to toggle pinned:', m.notifications_pin_chat_failed(), error);
		}
	}

	async function handleToggleArchive(chatId: string) {
		const chat = chats.find((s) => s.id === chatId);
		const wasArchived = chat?.isArchived === true;
		const isSelectedChat = selectedChatId === chatId;
		const isArchivingSelectedChat = !wasArchived && isSelectedChat;
		const chatIndex = chats.findIndex((s) => s.id === chatId);
		const neighborId =
			isArchivingSelectedChat && chatIndex >= 0
				? (chats[chatIndex + 1]?.id ?? chats[chatIndex - 1]?.id ?? null)
				: null;
		try {
			await controller.toggleArchive(chatId);
			if (isArchivingSelectedChat) {
				if (neighborId) {
					onChatSelect(neighborId);
				} else {
					onNewChat();
				}
				return;
			}
			if (wasArchived && isSelectedChat) {
				appShell.requestSidebarRecenterToSelected();
			}
		} catch (error) {
			reportActionFailure(
				'Failed to toggle archive:',
				m.notifications_archive_chat_failed(),
				error,
			);
		}
	}

	function showDeleteConfirmation(chatId: string, chatTitle: string, agentId: SessionAgentId) {
		dialogs.showDeleteConfirmation(chatId, chatTitle, agentId);
	}

	async function confirmDeleteChat() {
		if (!dialogs.chatDeleteConfirmation) return;
		const { chatId } = dialogs.chatDeleteConfirmation;
		dialogs.clearDeleteConfirmation();
		await onChatDelete?.(chatId);
	}

	function startRenameChat(chatId: string, currentName: string) {
		dialogs.startRename(chatId, currentName);
	}

	function startProjectPathUpdate(
		chatId: string,
		chatTitle: string,
		currentProjectPath: string,
	) {
		dialogs.showProjectPathDialog(chatId, chatTitle, currentProjectPath);
	}

	async function confirmRenameChat(newName: string) {
		if (!dialogs.chatRenameConfirmation) return;
		const { chatId } = dialogs.chatRenameConfirmation;
		dialogs.clearRename();
		await onChatRenamed?.(chatId, newName.trim());
		if (chatId === selectedChatId) {
			appShell.requestComposerFocus();
		}
	}

	function closeChatDetails() {
		dialogs.closeDetails();
	}

	function showChatDetails(chatId: string, chatTitle: string) {
		dialogs.showDetails(chatId, chatTitle);

		void (async () => {
			try {
				const details = await controller.loadDetails(chatId);
				dialogs.completeDetails(chatId, {
					firstMessage: details.firstMessage,
					createdAt: details.createdAt,
					lastActivityAt: details.lastActivityAt,
					agentSessionId: details.agentSessionId,
					nativePath: details.nativePath,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				dialogs.failDetails(chatId, message || m.sidebar_details_error_loading());
			}
		})();
	}

	function showTagDialog(chatId: string, currentTags: string[]) {
		const chat = chats.find((s) => s.id === chatId);
		dialogs.showTagDialog(chatId, chat?.title || m.sidebar_chats_unnamed(), currentTags);
	}

	function handleTagClick(tag: string) {
		sidebarSearch.applyQuery(addTagToQuery(sidebarSearch.activeQuery, tag));
	}

	async function handleSaveTags(chatId: string, tags: string[]) {
		await controller.updateTags(chatId, tags);
		dialogs.closeTagDialog();
	}

	function handlePrimaryAction() {
		if (selection.isActive) selection.exit();
		onNewChat();
	}

	const quickMoveQueue = createPerListWriteQueue<ChatOrderList, QuickMoveWrite>(
		async ({ chatId, target }) => {
			await controller.quickMove(chatId, target);
		},
		(error, task) => {
			reportActionFailure(
				`Failed to quick reorder ${task.list} chat order:`,
				m.notifications_reorder_chats_failed(),
				error,
			);
		},
	);

	function handleQuickMove(
		list: ChatOrderList,
		chatId: string,
		target: ReorderQuickTarget,
		onSuccess?: () => void,
		onFailure?: () => void,
	) {
		quickMoveQueue.enqueue({ list, chatId, target, onSuccess, onFailure });
	}

	// Multi-select mode handlers.

	function enterMultiSelect(chatId: string) {
		selection.enter(chatId);
	}

	function handleMultiSelectToggle(chatId: string, shiftKey: boolean) {
		if (shiftKey) {
			const allVisibleIds = sidebarSearch.filteredChats.map((c) => c.id);
			selection.selectRange(allVisibleIds, chatId);
		} else {
			selection.toggle(chatId);
		}
	}

	function handleSelectAll() {
		selection.selectAll(sidebarSearch.filteredChats.map((c) => c.id));
	}

	function handleDeselectAll() {
		selection.deselectAll();
	}

	function exitMultiSelect() {
		selection.exit();
	}

	// Prunes stale selections when the chat list changes (server refresh,
	// external delete, filter change).
	$effect(() => {
		if (!selection.isActive) return;
		const visibleIds = new Set(chats.map((c) => c.id));
		selection.pruneToVisible(visibleIds);
	});

	// Authoritative list of selected chats that still exist in the current
	// chat list. All display counts and actions derive from this.
	let selectedChats = $derived.by(() => {
		if (!selection.isActive) return [];
		return chats.filter((c) => selection.isSelected(c.id));
	});

	let bulkShowPin = $derived(selectedChats.some((c) => !c.isPinned));
	let bulkShowUnpin = $derived(selectedChats.some((c) => c.isPinned));
	let bulkShowArchive = $derived(selectedChats.some((c) => !c.isArchived));
	let bulkShowUnarchive = $derived(selectedChats.some((c) => c.isArchived));

	async function handleBulkOperation(
		action: SidebarBulkAction,
		logMessage: string,
		userMessage: string,
	) {
		isBulkOperating = true;
		try {
			const result = await controller.runBulkOperation(action, {
				selectedChats,
				allChats: chats,
				selectedChatId,
			});
			if (result.nextSelectedChatId) {
				onChatSelect(result.nextSelectedChatId);
			} else if (result.shouldCreateNewChat) {
				onNewChat();
			}
		} catch (error) {
			reportActionFailure(logMessage, userMessage, error);
		} finally {
			isBulkOperating = false;
			selection.exit();
		}
	}

	function handleBulkDeleteRequest() {
		dialogs.requestBulkDelete(selectedChats, m.sidebar_chats_unnamed());
	}

	async function confirmBulkDelete() {
		if (!dialogs.bulkDeleteConfirmation) return;
		const ids = dialogs.bulkDeleteConfirmation.chatIds;
		dialogs.clearBulkDelete();
		const isSelectedChatInBulk = selectedChatId && ids.includes(selectedChatId);
		// Resolve the surviving neighbor before the optimistic removal runs.
		const remainingSelection = isSelectedChatInBulk
			? (chats.find((c) => !ids.includes(c.id))?.id ?? null)
			: null;
		isBulkOperating = true;
		try {
			// Drop from the store immediately so the list updates without
			// waiting for every DELETE response to come back.
			if (onLocallyDeleteChat) {
				for (const id of ids) onLocallyDeleteChat(id);
			}
			if (isSelectedChatInBulk) {
				if (remainingSelection) onChatSelect(remainingSelection);
				else onNewChat();
			}
			await controller.bulkDelete(ids);
		} catch (error) {
			reportActionFailure('Failed to bulk delete:', m.notifications_bulk_delete_failed(), error);
		} finally {
			isBulkOperating = false;
			selection.exit();
		}
	}

	// Exits multi-select on Escape key.
	function handleSidebarKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && selection.isActive) {
			e.stopPropagation();
			selection.exit();
		}
	}

	async function handleForkChat(sourceChatId: string) {
		try {
			const resultChatId = await controller.forkChat(sourceChatId);
			onChatSelect(resultChatId);
		} catch (error) {
			reportActionFailure('Failed to fork chat:', m.notifications_fork_chat_failed(), error);
		}
	}

	async function confirmProjectPathUpdate(chatId: string, projectPath: string): Promise<void> {
		const result = await controller.updateProjectPath(chatId, projectPath);
		onChatProjectPathUpdated?.(chatId, result.projectPath);
	}

	async function handleReloadChat(chatId: string) {
		if (!onReloadChat) return;
		try {
			await onReloadChat(chatId);
		} catch (error) {
			reportActionFailure(
				'Failed to reload chat from native history:',
				m.sidebar_chats_reload_failed(),
				error,
			);
		}
	}

	async function handleMarkAllRead() {
		if (isMarkingAllRead || visibleUnreadChatIds.length === 0) return;
		isMarkingAllRead = true;
		try {
			await readReceiptOutbox.markChatsReadNow(visibleUnreadChatIds);
		} catch (error) {
			reportActionFailure(
				'Failed to mark chats read:',
				m.notifications_mark_all_read_failed(),
				error,
			);
		} finally {
			isMarkingAllRead = false;
		}
	}

	// Search dialog actions.

	function handleSearchSelectChat(chatId: string) {
		sidebarSearch.confirmSearchDialog();
		onChatSelect(chatId);
	}

	function handleApplySavedSearch(search: SavedChatSearch) {
		sidebarSearch.updateDraftQuery(search.query);
	}

	function handleApplySidebarMenuSearch(query: string) {
		sidebarSearch.applyQuery(query);
	}

	function handleApplySidebarPillSearch(search: SavedChatSearch) {
		sidebarSearch.applyQuery(search.query);
	}

	function handleClearActiveQuery() {
		sidebarSearch.applyQuery('');
	}

	// Lifecycle.

	onMount(() =>
		appShell.onRenameSelectedChatRequested(() => {
			if (!selectedChatId) return;
			const selected = chats.find((chat) => chat.id === selectedChatId);
			if (!selected) return;
			startRenameChat(selected.id, selected.title || m.sidebar_chats_new_chat());
		}),
	);

	onMount(() =>
		appShell.onDeleteSelectedChatRequested(() => {
			if (!selectedChatId) return;
			const selected = chats.find((chat) => chat.id === selectedChatId);
			if (!selected) return;
			showDeleteConfirmation(
				selected.id,
				selected.title || m.sidebar_chats_new_chat(),
				selected.agentId,
			);
		}),
	);

	onMount(() =>
		appShell.onSidebarSearchRequested(() => {
			sidebarSearch.toggleSearchDialog();
		}),
	);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -- keydown on container for Escape handling -->
<div class="h-full flex flex-col bg-card md:select-none relative" onkeydown={handleSidebarKeydown}>
	<div class="order-1 flex-shrink-0">
		<SidebarSearchDock
			{isLoading}
			visibleUnreadCount={visibleUnreadChatIds.length}
			{isMarkingAllRead}
			sidebarMenuSearches={sidebarSearch.sidebarMenuSearches}
			sidebarPillSearches={sidebarSearch.sidebarPillSearches}
			activeQuery={sidebarSearch.activeQuery}
			onOpenSearchDialog={() => sidebarSearch.openSearchDialog()}
			onCreateChat={handlePrimaryAction}
			onMarkAllRead={() => {
				void handleMarkAllRead();
			}}
			onApplySidebarMenuSearch={handleApplySidebarMenuSearch}
			onApplyPillSearch={handleApplySidebarPillSearch}
			onClearActiveQuery={handleClearActiveQuery}
			{onShowSettings}
		/>
	</div>

	<div class="order-2 flex min-h-0 flex-1">
		<SidebarContent
			{chats}
			filteredChats={sidebarSearch.filteredChats}
			{selectedChatId}
			{isLoading}
			{isMobile}
			{currentTime}
			searchFilter={sidebarSearch.activeQuery}
			isMultiSelectMode={selection.isActive}
			isMultiSelected={(id) => selection.isSelected(id)}
			onEnterMultiSelect={enterMultiSelect}
			onMultiSelectToggle={handleMultiSelectToggle}
			onChatSelect={handleChatClick}
				onDeleteChat={showDeleteConfirmation}
				onStartRenameChat={startRenameChat}
				onStartUpdateProjectPath={startProjectPathUpdate}
				onTogglePinned={(id) => {
					void handleTogglePinned(id);
				}}
			onToggleArchive={(id) => {
				void handleToggleArchive(id);
			}}
			onShowDetails={showChatDetails}
			onForkChat={(id) => {
				void handleForkChat(id);
			}}
			onReloadChat={(id) => {
				void handleReloadChat(id);
			}}
			onShareChat={(id, title) => {
				dialogs.showShareDialog(id, title);
			}}
			onTagClick={handleTagClick}
			onManageTags={showTagDialog}
			onQuickMove={handleQuickMove}
		/>
	</div>

	{#if selection.isActive}
		<SidebarSelectionBar
			count={selectedChats.length}
			totalVisible={sidebarSearch.filteredChats.length}
			showPin={bulkShowPin}
			showUnpin={bulkShowUnpin}
			showArchive={bulkShowArchive}
			showUnarchive={bulkShowUnarchive}
			isOperating={isBulkOperating}
			onSelectAll={handleSelectAll}
			onDeselectAll={handleDeselectAll}
			onPin={() => {
				void handleBulkOperation('pin', 'Failed to bulk pin:', m.notifications_bulk_pin_failed());
			}}
			onUnpin={() => {
				void handleBulkOperation(
					'unpin',
					'Failed to bulk unpin:',
					m.notifications_bulk_unpin_failed(),
				);
			}}
			onArchive={() => {
				void handleBulkOperation(
					'archive',
					'Failed to bulk archive:',
					m.notifications_bulk_archive_failed(),
				);
			}}
			onUnarchive={() => {
				void handleBulkOperation(
					'unarchive',
					'Failed to bulk unarchive:',
					m.notifications_bulk_unarchive_failed(),
				);
			}}
			onDelete={handleBulkDeleteRequest}
			onDone={exitMultiSelect}
		/>
	{/if}
</div>

<SidebarChatDialogs
	chatDeleteConfirmation={dialogs.chatDeleteConfirmation}
	onCancelDelete={() => dialogs.clearDeleteConfirmation()}
	onConfirmDelete={confirmDeleteChat}
	chatRenameConfirmation={dialogs.chatRenameConfirmation}
	onCancelRename={() => dialogs.clearRename()}
	onConfirmRename={confirmRenameChat}
		chatDetailsDialog={dialogs.chatDetailsDialog}
		onCloseDetails={closeChatDetails}
	/>

	<SidebarProjectPathDialog
		projectPathDialog={dialogs.chatProjectPathDialog}
		projectBasePath={appShell.projectBasePath}
		{isMobile}
		onClose={() => dialogs.closeProjectPathDialog()}
		onConfirm={confirmProjectPathUpdate}
	/>

	<!-- Bulk delete confirmation dialog -->
<Dialog.Root
	open={dialogs.bulkDeleteConfirmation !== null}
	onOpenChange={(open) => {
		if (!open) dialogs.clearBulkDelete();
	}}
>
	<Dialog.Content>
		<Dialog.Header class="min-w-0">
			<Dialog.Title
				>{m.sidebar_select_delete_confirm_title({
					count: dialogs.bulkDeleteConfirmation?.chatIds.length ?? 0,
				})}</Dialog.Title
			>
			<Dialog.Description class="min-w-0 max-w-full">
				<span class="block text-sm text-muted-foreground mb-2"
					>{m.sidebar_select_delete_confirm_description()}</span
				>
				{#if dialogs.bulkDeleteConfirmation}
					<ul class="list-disc pl-4 space-y-0.5 text-sm text-foreground max-h-32 overflow-y-auto">
						{#each dialogs.bulkDeleteConfirmation.chatTitles.slice(0, 5) as title}
							<li class="truncate">{title}</li>
						{/each}
						{#if dialogs.bulkDeleteConfirmation.chatTitles.length > 5}
							<li class="text-muted-foreground italic">
								{m.sidebar_select_delete_confirm_and_more({
									count: dialogs.bulkDeleteConfirmation.chatTitles.length - 5,
								})}
							</li>
						{/if}
					</ul>
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => dialogs.clearBulkDelete()}
				>{m.sidebar_actions_cancel()}</Button
			>
			<Button
				variant="destructive"
				onclick={() => {
					void confirmBulkDelete();
				}}>{m.sidebar_actions_delete()}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<SidebarTagDialog
	tagDialog={dialogs.tagDialog}
	allKnownTags={sidebarSearch.allKnownTags}
	onClose={() => dialogs.closeTagDialog()}
	onSave={handleSaveTags}
/>

<SidebarSearchDialog
	open={sidebarSearch.searchDialogOpen}
	query={sidebarSearch.draftQuery}
	filteredChats={sidebarSearch.dialogFilteredChats}
	savedSearches={sidebarSearch.searchDialogSavedSearches}
	{currentTime}
	highlightedIndex={sidebarSearch.highlightedResultIndex}
	onQueryChange={(q) => sidebarSearch.updateDraftQuery(q)}
	onSelectChat={handleSearchSelectChat}
	onApplySavedSearch={handleApplySavedSearch}
	onOpenManager={() => sidebarSearch.openManagerFromSearchDialog()}
	onCreateSavedSearch={() => sidebarSearch.openEditorForCreateFromSearchDialog()}
	onHighlightChange={(i) => {
		sidebarSearch.highlightedResultIndex = i;
	}}
	onClose={() => sidebarSearch.closeSearchDialog()}
/>

<SavedSearchManagerDialog
	open={sidebarSearch.managerOpen}
	searches={sidebarSearch.savedSearches}
	onClose={() => sidebarSearch.closeManager()}
	onAdd={() => sidebarSearch.openEditorForCreate()}
	onEdit={(search) => sidebarSearch.openEditorForEdit(search)}
	onDelete={(id) => sidebarSearch.requestDelete(id)}
	onReorder={(oldOrder, newOrder) => {
		void sidebarSearch.reorder(oldOrder, newOrder);
	}}
/>

<SavedSearchEditorDialog
	editorState={sidebarSearch.editorState}
	onClose={() => {
		sidebarSearch.closeEditor();
	}}
	onSave={(data, searchId) => sidebarSearch.saveEditor(data, searchId)}
/>

<ShareChatDialog
	chatId={dialogs.shareChatDialog?.chatId ?? null}
	chatTitle={dialogs.shareChatDialog?.chatTitle ?? ''}
	onClose={() => {
		dialogs.closeShareDialog();
	}}
/>

<Dialog.Root
	open={sidebarSearch.deleteConfirmation !== null}
	onOpenChange={(open) => {
		if (!open) sidebarSearch.clearDeleteConfirmation();
	}}
>
	<Dialog.Content
		onOpenAutoFocus={(e) => {
			e.preventDefault();
			sidebarSearch.deleteButtonRef?.focus();
		}}
	>
		<Dialog.Header>
			<Dialog.Title>{m.sidebar_saved_searches_confirm_delete()}</Dialog.Title>
			<Dialog.Description
				>{m.sidebar_saved_searches_confirm_delete_description()}</Dialog.Description
			>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => sidebarSearch.clearDeleteConfirmation()}
				>{m.sidebar_actions_cancel()}</Button
			>
			<Button
				variant="destructive"
				onclick={() => {
					void sidebarSearch.confirmDelete();
				}}
				bind:ref={sidebarSearch.deleteButtonRef}>{m.sidebar_actions_delete()}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
