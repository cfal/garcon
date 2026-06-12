<script lang="ts">
	// Thin composition shell for the chat workspace. Wires extracted
	// controllers (session, scroll, router) and renders the message
	// pane, queue controls, and composer. All business logic lives in
	// the controller modules.

	import { onDestroy, onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import ConversationFeed from './ConversationFeed.svelte';
	import PromptComposer from './PromptComposer.svelte';
	import QueueControls from './QueueControls.svelte';
	import { ChatState } from '$lib/chat/state.svelte';
	import { ComposerState } from '$lib/chat/composer.svelte';
	import { AgentState } from '$lib/chat/agent-state.svelte';
	import { getChatQueue } from '$lib/api/chats.js';
	import { StartupCoordinator } from '$lib/chat/startup-coordinator.js';
	import { createDrainCursor } from '$lib/ws/drain';
	import { mountConversationRouter } from '$lib/chat/conversation-router-adapter.svelte';
	import { ConversationSessionController } from '$lib/chat/conversation-session-controller.svelte';
	import { ConversationScrollController } from '$lib/chat/conversation-scroll-controller.svelte';
	import { ChatLifecycleStore } from '$lib/stores/chat-lifecycle.svelte';
	import { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';
	import {
		getChatSessions,
		getLocalSettings,
		getAppShell,
		getWs,
		getNavigation,
		setChatState,
		setComposerState,
		setAgentState,
		setChatLifecycle,
		getReadReceiptOutbox,
		getModelCatalog,
	} from '$lib/context';
	import { ArrowDown, ArrowUp, Loader2 } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';

	interface ConversationWorkspaceProps {
		onRegisterSubmit?: (fn: (message: string) => Promise<boolean>) => void;
		reserveTopFloatingToolbar?: boolean;
	}

	let { onRegisterSubmit, reserveTopFloatingToolbar = false }: ConversationWorkspaceProps =
		$props();

	const sessions = getChatSessions();
	const localSettings = getLocalSettings();
	const appShell = getAppShell();
	const ws = getWs();
	const navigation = getNavigation();
	const readReceiptOutbox = getReadReceiptOutbox();
	const modelCatalog = getModelCatalog();

	const chatState = new ChatState();
	const composerState = new ComposerState();
	const agentState = new AgentState();
	const lifecycle = new ChatLifecycleStore();
	const conversationUi = new ConversationUiStore();
	const startupCoordinator = new StartupCoordinator();

	setChatState(chatState);
	setComposerState(composerState);
	setAgentState(agentState);
	setChatLifecycle(lifecycle);

	const activeQueue = $derived.by(() => {
		const chatId = sessions.selectedChatId;
		return conversationUi.getQueue(chatId);
	});
	const scrollToTopButtonClass = $derived(
		cn(
			'absolute right-5 sm:right-6 z-20 w-11 h-11 rounded-full shadow-md hover:shadow-lg',
			reserveTopFloatingToolbar ? 'top-16' : 'top-3',
		),
	);

	let scrollContainer: HTMLDivElement | null = $state(null);
	let queueControlsContainer: HTMLDivElement | undefined = $state();

	// WS drain and event router.
	const drainHandle = createDrainCursor(ws);
	onDestroy(() => drainHandle.cleanup());

	mountConversationRouter({
		ws,
		drainHandle,
		sessions,
		chatState,
		agentState,
		lifecycle,
		conversationUi,
		startupCoordinator,
		readReceiptOutbox,
	});

	conversationUi.mountQueuePruning({
		getActiveChatIds: () => new Set(Object.keys(sessions.byId)),
	});

	// Scroll controller.
	const scroll = new ConversationScrollController({
		getScrollContainer: () => scrollContainer,
		getQueueContainer: () => queueControlsContainer,
		chatState,
		sessions,
	});

	// Session controller.
	const controller = new ConversationSessionController({
		sessions,
		chatState,
		composerState,
		agentState,
		lifecycle,
		conversationUi,
		startupCoordinator,
		modelCatalog,
		appShell,
		readReceiptOutbox,
		navigation: {
			setActiveTab: (tab) => navigation.setActiveTab(tab),
			navigateToChat: (chatId) => {
				sessions.setSelectedChatId(chatId);
				goto(`/chat/${chatId}`);
			},
		},
		setIsViewportPinnedToBottom: (v) => {
			scroll.isPinnedToBottom = v;
		},
		scrollToBottom: () => scroll.scrollToBottom(),
	});

	// Expose the submit function to sibling components (runs once on mount).
	onMount(() => {
		onRegisterSubmit?.(submitToActiveChat);
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
				void getChatQueue(selected.id)
					.then((result) => {
						conversationUi.setMessageQueue(selected.id, result.queue);
					})
					.catch(() => {
						// Queue state will converge through later broadcasts.
					});
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
		const _count = chatState.displayMessageCount;
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
		untrack(() => {
			if (_container && chatState.displayMessageCount > 0 && localSettings.autoScrollToBottom) {
				requestAnimationFrame(() => scroll.scrollToBottom());
			}
		});
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
				pendingPermissionRequests={conversationUi.pendingPermissionRequests}
				onRetry={() => {
					const chatId = sessions.selectedChatId;
					if (chatId) controller.loadChat(chatId);
				}}
				reserveLoadingStatusSpace={lifecycle.isLoading}
			/>

			{#if chatState.isUserScrolledUp && chatState.displayMessageCount > 0}
				<Button
					variant="outline"
					size="icon"
					class={scrollToTopButtonClass}
					onclick={() => scroll.scrollToTop()}
					disabled={scroll.isScrollingToTop}
					title={m.workspace_scroll_to_initial_prompt()}
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
					title={m.workspace_scroll_to_bottom()}
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
