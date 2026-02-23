<script lang="ts">
	// Thin composition shell for the chat workspace. Wires extracted
	// controllers (session, scroll, router) and renders the message
	// pane, queue controls, and composer. All business logic lives in
	// the controller modules.

	import { onDestroy, untrack } from 'svelte';
	import ConversationFeed from './ConversationFeed.svelte';
	import PromptComposer from './PromptComposer.svelte';
	import LoadingStatus from './LoadingStatus.svelte';
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
	import { getChatSessions, getPreferences, getAppShell, getWs, getNavigation, setChatState, setComposerState, setProviderState, setChatLifecycle, getReadReceiptOutbox } from '$lib/context';
	import type { PendingPermissionRequest, QueueState, PermissionMode, PendingViewChat } from '$lib/types/chat';
	import { ArrowDown } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';

	interface ConversationWorkspaceProps {
		onRegisterSubmit?: (fn: (message: string) => Promise<boolean>) => void;
	}

	let { onRegisterSubmit }: ConversationWorkspaceProps = $props();

	const sessions = getChatSessions();
	const preferences = getPreferences();
	const appShell = getAppShell();
	const ws = getWs();
	const navigation = getNavigation();
	const readReceiptOutbox = getReadReceiptOutbox();

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

	// Reloads the current chat when WS reconnects after a failed load.
	$effect(() => {
		const connected = ws.isConnected;
		untrack(() => {
			const selected = sessions.selectedChat;
			if (connected && selected && selected.status === 'running') {
				ws.sendMessage(new QueueQueryRequest(selected.id));
			}
			if (connected && (needsServerLoad || chatState.loadStatus === 'error')) {
				const chatId = sessions.selectedChatId;
				if (chatId) {
					controller.loadChat(chatId);
				}
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

	// Scrolls to bottom on new messages unless user scrolled up.
	$effect(() => {
		const _count = chatState.chatMessages.length;
		if (!chatState.isUserScrolledUp && preferences.autoScrollToBottom) {
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
			<p>Select a project to start chatting</p>
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
			/>

			{#if chatState.isUserScrolledUp && chatState.chatMessages.length > 0}
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

			<LoadingStatus
				isLoading={lifecycle.isLoading}
				status={lifecycle.loadingStatus}
				provider={providerState.provider}
				spinnerSelectionKey={sessions.selectedChatId}
				isScrolledToBottom={!chatState.isUserScrolledUp}
				onAbort={() => controller.handleAbort()}
			/>
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
			/>
		</div>
		{/if}
