<script lang="ts">
	// Thin composition shell for the chat workspace. Wires extracted
	// controllers (session, scroll, router) and renders the message
	// pane, queue controls, and composer. All business logic lives in
	// the controller modules.

	import { onDestroy, untrack } from 'svelte';
	import ConversationFeed from './ConversationFeed.svelte';
	import PromptComposer from './PromptComposer.svelte';
	import QueueControls from './QueueControls.svelte';
	import { ChatState } from '$lib/chat/state.svelte';
	import { ComposerState } from '$lib/chat/composer.svelte';
	import { ProviderState } from '$lib/chat/provider-state.svelte';
	import { QueueQueryRequest } from '$shared/ws-requests';
	import { StartupCoordinator } from '$lib/chat/startup-coordinator.js';
	import { createDrainCursor } from '$lib/ws/drain';
	import { mountConversationRouter } from '$lib/chat/conversation-router-adapter.svelte';
	import { ConversationSessionController } from '$lib/chat/conversation-session-controller.svelte';
	import { ConversationScrollController } from '$lib/chat/conversation-scroll-controller.svelte';
	import { ChatLifecycleStore } from '$lib/stores/chat-lifecycle.svelte';
	import { getChatSessions, getLocalSettings, getAppShell, getWs, getNavigation, setChatState, setComposerState, setProviderState, setChatLifecycle, getReadReceiptOutbox, getModelCatalog } from '$lib/context';
	import type { PendingPermissionRequest, QueueState, PermissionMode, PendingViewChat } from '$lib/types/chat';
	import { ArrowDown, ArrowUp, Loader2 } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';

	interface ConversationWorkspaceProps {
		onRegisterSubmit?: (fn: (message: string) => Promise<boolean>) => void;
		reserveTopFloatingToolbar?: boolean;
	}

	let { onRegisterSubmit, reserveTopFloatingToolbar = false }: ConversationWorkspaceProps = $props();

	const sessions = getChatSessions();
	const localSettings = getLocalSettings();
	const appShell = getAppShell();
	const ws = getWs();
	const navigation = getNavigation();
	const readReceiptOutbox = getReadReceiptOutbox();
	const modelCatalog = getModelCatalog();

	const chatState = new ChatState();
	const composerState = new ComposerState();
	const providerState = new ProviderState();
	const lifecycle = new ChatLifecycleStore();
	const startupCoordinator = new StartupCoordinator();

	setChatState(chatState);
	setComposerState(composerState);
	setProviderState(providerState);
	setChatLifecycle(lifecycle);

	// Per-chat reactive state for permissions and queue.
	let pendingPermissionRequests = $state<PendingPermissionRequest[]>([]);
	let queueByChatId = $state<Record<string, QueueState | null>>({});
	let pendingViewChat = $state<PendingViewChat | null>(null);
	let previousPermissionMode = $state<PermissionMode | null>(null);
	let needsServerLoad = $state(false);
	const activeQueue = $derived.by(() => {
		const chatId = sessions.selectedChatId;
		if (!chatId) return null;
		return queueByChatId[chatId] ?? null;
	});
	const scrollToTopButtonClass = $derived(cn(
		'absolute right-5 sm:right-6 z-20 w-11 h-11 rounded-full shadow-md hover:shadow-lg',
		reserveTopFloatingToolbar ? 'top-16' : 'top-3',
	));

	let scrollContainer: HTMLDivElement | undefined = $state();
	let queueControlsContainer: HTMLDivElement | undefined = $state();

	// WS drain and event router.
	const drainHandle = createDrainCursor(ws);
	onDestroy(() => drainHandle.cleanup());

	mountConversationRouter({
		ws,
		drainHandle,
		sessions,
		chatState,
		composerState,
		providerState,
		lifecycle,
		startupCoordinator,
		appShell,
		readReceiptOutbox,
		getPendingPermissionRequests: () => pendingPermissionRequests,
		setPendingPermissionRequests: (updater) => {
			if (typeof updater === 'function') {
				pendingPermissionRequests = updater(pendingPermissionRequests);
			} else {
				pendingPermissionRequests = updater;
			}
		},
		getPendingViewChat: () => pendingViewChat,
		setPendingViewChat: (v) => { pendingViewChat = v; },
		setMessageQueue: (chatId, q) => {
			queueByChatId = { ...queueByChatId, [chatId]: q };
		},
		getPreviousPermissionMode: () => previousPermissionMode,
		setPreviousPermissionMode: (mode) => { previousPermissionMode = mode; },
	});

	// Scroll controller.
	const scroll = new ConversationScrollController({
		getScrollContainer: () => scrollContainer,
		getQueueContainer: () => queueControlsContainer,
		chatState,
		sessions,
		ws,
	});

	// Session controller.
	const controller = new ConversationSessionController({
		sessions,
		chatState,
		composerState,
		providerState,
		lifecycle,
		startupCoordinator,
		ws,
		modelCatalog,
		appShell,
		readReceiptOutbox,
		navigation,
		getPendingPermissionRequests: () => pendingPermissionRequests,
		setPendingPermissionRequests: (v) => { pendingPermissionRequests = v; },
		getPreviousPermissionMode: () => previousPermissionMode,
		setPreviousPermissionMode: (v) => { previousPermissionMode = v; },
		setNeedsServerLoad: (v) => { needsServerLoad = v; },
		setIsViewportPinnedToBottom: (v) => { scroll.isPinnedToBottom = v; },
		scrollToBottom: () => scroll.scrollToBottom(),
	});

	// Expose the submit function to sibling components (runs once on mount).
	$effect(() => {
		untrack(() => {
			if (onRegisterSubmit) onRegisterSubmit(submitToActiveChat);
		});
	});

	// Chat switch effect (dedup handled inside the controller).
	$effect(() => {
		controller.handleChatSwitchIfChanged(sessions.selectedChatId);
	});

	// Reloads the current chat when WS reconnects after a disconnect.
	// Marks the active snapshot stale before revalidating so the cache
	// reflects that messages may have been missed while offline.
	// Skips the first connection since handleChatSwitch already loads.
	let hasConnectedBefore = false;

	$effect(() => {
		const connected = ws.isConnected;
		untrack(() => {
			if (!connected) return;

			const selected = sessions.selectedChat;
			const chatId = sessions.selectedChatId;

			if (selected && selected.status === 'running') {
				ws.sendMessage(new QueueQueryRequest(selected.id));
			}

			if (!hasConnectedBefore) {
				hasConnectedBefore = true;
				return;
			}

			if (chatId) {
				chatState.snapshotCache.markStale(chatId);
				controller.loadChat(chatId);
			}
		});
	});

	// Syncs lifecycle.isLoading from the selected chat's isProcessing flag.
	$effect(() => {
		const selected = sessions.selectedChat;
		const isProcessing = Boolean(selected?.isProcessing);
		untrack(() => {
			if (isProcessing) {
				if (!lifecycle.isLoading) lifecycle.setIsLoading(true);
				return;
			}
			if (lifecycle.isLoading) lifecycle.setIsLoading(false);
		});
	});

	// Prunes queue cache entries for chats no longer present in session state.
	$effect(() => {
		const activeChatIds = new Set(Object.keys(sessions.byId));
		const staleIds = Object.keys(queueByChatId).filter((chatId) => !activeChatIds.has(chatId));
		if (staleIds.length === 0) return;
		const nextQueueByChatId = { ...queueByChatId };
		for (const chatId of staleIds) {
			delete nextQueueByChatId[chatId];
		}
		queueByChatId = nextQueueByChatId;
	});

	// Debounced persistence to avoid main-thread JSON.stringify per token during streaming.
	let persistTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		const chatId = sessions.selectedChatId;
		const _messages = chatState.chatMessages;
		if (!chatId) return;
		if (persistTimer) clearTimeout(persistTimer);
		persistTimer = setTimeout(() => {
			chatState.persistMessages(chatId);
		}, 800);
		return () => {
			// Flush on cleanup to avoid data loss when navigating away.
			if (persistTimer) {
				clearTimeout(persistTimer);
				chatState.persistMessages(chatId);
			}
		};
	});

	// Scrolls to bottom on new messages and loading status changes unless user scrolled up.
	$effect(() => {
		const _count = chatState.chatMessages.length;
		const _isLoading = lifecycle.isLoading;
		if (!chatState.isUserScrolledUp && localSettings.autoScrollToBottom) {
			requestAnimationFrame(() => scroll.scrollToBottom());
		}
	});

	// Scrolls to bottom when the scroll container mounts (e.g. after
	// split-pane focus change remounts ConversationWorkspace in a new pane).
	// The bind:this resolves after initial render, so earlier scrollToBottom
	// calls from loadChat fire against an undefined container.
	$effect(() => {
		const _container = scrollContainer;
		if (_container && chatState.chatMessages.length > 0) {
			requestAnimationFrame(() => scroll.scrollToBottom());
		}
	});

	// Preserves viewport anchoring when queue controls change height.
	$effect(() => {
		const _host = queueControlsContainer;
		const _scroller = scrollContainer;
		const _selected = sessions.selectedChatId;
		return scroll.observeQueueResize();
	});

	// Keeps bottom-pinned chats pinned when the message viewport height changes.
	$effect(() => {
		const _scroller = scrollContainer;
		const _selected = sessions.selectedChatId;
		return scroll.observeScrollContainerResize();
	});

	function handleGlobalKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && !event.repeat && lifecycle.isLoading && lifecycle.canAbort) {
			event.preventDefault();
			controller.handleAbort();
		}
		scroll.handleHalfPageScroll(event);
	}

	function onSubmit(text?: string, images?: File[]) {
		const chatId = sessions.selectedChatId;
		if (!chatId) return;
		void controller.submitForChat(chatId, text, images);
	}

	// Exposes a chat submit function for sibling components (e.g. git review).
	async function submitToActiveChat(message: string): Promise<boolean> {
		const chatId = sessions.selectedChatId;
		if (!chatId) return false;
		try {
			await controller.submitForChat(chatId, message);
			return true;
		} catch {
			return false;
		}
	}

	const projectPath = $derived(sessions.selectedChat?.projectPath || null);
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

{#if !projectPath}
	<div class="flex items-center justify-center h-full">
		<div class="text-center text-muted-foreground">
			<p>{m.chat_workspace_select_project()}</p>
		</div>
	</div>
{:else}
	<div class="h-full flex flex-col">
		<div class="relative flex-1 min-h-0">
			<ConversationFeed
				bind:scrollContainer
				onscroll={() => scroll.handleScroll()}
				onPermissionDecision={(id, d) => controller.handlePermissionDecision(id, d)}
				onExitPlanMode={(id, c, p) => controller.handleExitPlanMode(id, c, p)}
				{pendingPermissionRequests}
				onRetry={() => {
					const chatId = sessions.selectedChatId;
					if (chatId) controller.loadChat(chatId);
				}}
				reserveLoadingStatusSpace={lifecycle.isLoading}
			/>

			{#if chatState.isUserScrolledUp && chatState.chatMessages.length > 0}
					<Button
						variant="outline"
						size="icon"
						class={scrollToTopButtonClass}
						onclick={() => scroll.scrollToTop()}
						disabled={scroll.isScrollingToTop}
						title="Scroll to initial prompt"
				>
					{#if scroll.isScrollingToTop}
						<Loader2 class="w-5 h-5 animate-spin" />
					{:else}
						<ArrowUp class="w-5 h-5" />
					{/if}
				</Button>
				<Button
					variant="outline"
					size="icon"
					class="absolute bottom-14 right-5 sm:right-6 z-20 w-11 h-11 rounded-full shadow-md hover:shadow-lg"
					onclick={() => scroll.scrollToBottom()}
					title="Scroll to bottom"
				>
					<ArrowDown class="w-5 h-5" />
				</Button>
			{/if}
		</div>

			<div bind:this={queueControlsContainer}>
				<QueueControls
					queue={activeQueue}
					onResume={() => controller.handleQueueResume()}
					onPause={() => controller.handleQueuePause()}
					onDequeue={(id) => controller.handleDequeue(id)}
			/>
		</div>

			<PromptComposer
				onsubmit={onSubmit}
				onModelChange={(m) => controller.handleModelChange(m)}
				onPermissionModeChange={(m) => controller.handlePermissionModeChange(m)}
				onThinkingModeChange={(m) => controller.handleThinkingModeChange(m)}
				onAbort={() => controller.handleAbort()}
				/>
		</div>
		{/if}
