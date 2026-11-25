<script lang="ts">
	import { subscribeWorkspaceEvents } from '$lib/events/workspace-router.js';
	import { BrowserNotificationsRouter } from '$lib/events/browser-notifications-router.js';
	import { BrowserNotificationService } from '$lib/notifications/browser-notifications.js';
	import { gotoChat } from '$lib/chat/actions/chat-navigation.js';
	import { onMount, onDestroy, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import NativeReadySignal from '$lib/components/layout/NativeReadySignal.svelte';
	import { installNativeConnectionNotification } from '$lib/native/connection-notification.js';

	import ReauthenticationOverlay from '$lib/components/auth/ReauthenticationOverlay.svelte';
	import { AUTH_UNAVAILABLE_CLOSE_CODE } from '$shared/ws-auth';
	import { FileImageCache } from '$lib/files/images/file-image-cache.svelte.js';
	import { setFileImages } from '$lib/context/file-images-context.js';
	import { createRemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
	import { createScheduledPromptsStore } from '$lib/scheduling/scheduled-prompts-store.svelte.js';
	import { createPreamblesStore } from '$lib/preambles/preambles-store.svelte.js';
	import { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
	import { ExecutorInventoryChanges } from '$lib/executors/executor-inventory-changes.js';
	import { ApiProvidersStore } from '$lib/api-providers/api-providers-store.svelte.js';
	import { createChatPreambleSelectionInvalidationHub } from '$lib/preambles/chat-selection-invalidation-hub.js';
	import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
	import { createMinuteClockStore } from '$lib/stores/minute-clock.svelte.js';
	import { createNavigationStore } from '$lib/stores/navigation.js';
	import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte.js';
	import { createWsConnection } from '$lib/ws/connection.svelte.js';
	import { ChatProcessingReconciler } from '$lib/ws/chat-processing-reconciler.svelte.js';
	import { createReadReceiptOutbox } from '$lib/chat/sessions/read-receipt-outbox.svelte.js';
	import { createModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
	import { installCompletionSoundUnlockListeners } from '$lib/notifications/completion-sound.js';
	import { createSidebarSearchStore } from '$lib/sidebar/search/sidebar-search-store.svelte.js';
	import { createGhCapabilityStore } from '$lib/git/pull-requests/gh-capability.svelte.js';
	import { PullRequestReviewsStore } from '$lib/git/pull-requests/pull-request-reviews-store.svelte.js';
	import { createSidebarProjectCollapseStore } from '$lib/sidebar/projects/sidebar-project-collapse.svelte.js';
	import { StartupOnboardingState } from '$lib/onboarding/startup-onboarding.js';
	import {
		getAuth,
		getLocalSettings,
		setNavigation,
		setChatSessions,
		setAppShell,
		setWs,
		setChatProcessingReconciler,
		setFileSessions,
		setReadReceiptOutbox,
		setModelCatalog,
		setRemoteSettings,
		setNotifications,
		setSidebarSearch,
		setSidebarProjectCollapse,
		setMinuteClock,
		setGhCapability,
		setPullRequestReviews,
		setScheduledPrompts,
		setPreambles,
		setExecutors,
		setApiProviders,
		setChatPreambleSelectionInvalidationHub,
		setSnippets,
		setWorkspaceLayout,
		setWorkspaceContext,
		setProjectResolution,
		setTerminalRegistry,
		setWorkspaceCoordinator,
		setWorkspaceWindowDnd,
		setWorkspaceHostGeometry,
		setTransientLayers,
		setSurfaceFrames,
		setWorkspaceShortcuts,
		setWorkbenchCommands,
		setGitQuickSummary,
		setGitBranchActions,
		setGitMutations,
		setGitReviewDisplay,
		setGitViewLauncher,
		setSingletonSurfaces,
	} from '$lib/context';
	import { TranscriptSearchStatusController } from '$lib/events/transcript-search-status-controller.js';
	import AppShell from '$lib/components/layout/AppShell.svelte';
	import CommandMenu from '$lib/components/shared/CommandMenu.svelte';
	import KeyboardShortcuts from '$lib/components/shared/KeyboardShortcuts.svelte';
	import { searchChatTranscripts } from '$lib/api/chats';
	import {
		getSessionStorageItem,
		SESSION_STORAGE_KEYS,
		setSessionStorageItem,
	} from '$lib/utils/local-persistence';
	import { TerminalClientIdentity } from '$lib/workspace/terminal-client-identity.svelte.js';
	import {
		isTerminalLauncherDismissed,
		serializeTerminalLauncherDismissal,
	} from '$lib/workspace/terminal-launcher-dismissal.js';
	import { createWorkspaceServices } from '$lib/workspace/workspace-services.js';
	import type { ThemeControllerDeps } from '$lib/theme/theme-controller.svelte.js';
	import { createChatBoardInvalidationHub } from '$lib/chat-board/catalog/chat-board-invalidation-hub.js';
	import { TicketsInvalidationHub } from '$lib/tickets/catalog/tickets-invalidation-hub.js';
	import { setTicketChat, setTicketsInvalidations } from '$lib/context/tickets-context.js';
	import { TicketChatController } from '$lib/tickets/chat/ticket-chat-controller.svelte.js';

	let {
		visible,
		terminalPresentation,
		editorPresentation,
	}: {
		visible: boolean;
		terminalPresentation: Parameters<ThemeControllerDeps['setTerminalPresentation']>[0] | null;
		editorPresentation: Parameters<ThemeControllerDeps['setEditorPresentation']>[0] | null;
	} = $props();

	const auth = getAuth();
	const localSettings = getLocalSettings();
	let terminalIdentity = $state.raw(new TerminalClientIdentity());
	const fileImages = new FileImageCache({
		budgetBytes: localSettings.imageCacheSizeMiB * 1024 * 1024,
		owner: null,
	});
	setFileImages(fileImages);
	$effect(() => fileImages.setIdleBudget(localSettings.imageCacheSizeMiB * 1024 * 1024));
	const remoteSettings = createRemoteSettingsStore();
	const scheduledPrompts = createScheduledPromptsStore();
	const preambles = createPreamblesStore();
	const executors = new ExecutorsStore();
	const chatPreambleSelectionInvalidationHub = createChatPreambleSelectionInvalidationHub();
	const chatBoardInvalidations = createChatBoardInvalidationHub();
	const ticketsInvalidations = new TicketsInvalidationHub();
	setTicketsInvalidations(ticketsInvalidations);
	const snippets = createSnippetsStore();
	const navigation = createNavigationStore();
	const notifications = createNotificationsStore();
	const sidebarProjectCollapse = createSidebarProjectCollapseStore();
	const chatSessions = createChatSessionsStore({
		notifyError: (message) => notifications.error(message),
		onChatDeleted: (id) => sidebarProjectCollapse.forgetDeletedChat(id),
	});
	const appShell = createAppShellStore();
	const ws = createWsConnection();
	const chatProcessingReconciler = new ChatProcessingReconciler(ws, chatSessions);
	const readReceiptOutbox = createReadReceiptOutbox(chatSessions);
	const modelCatalog = createModelCatalogStore();
	const executorInventory = new ExecutorInventoryChanges();
	$effect(() => {
		const snapshots = executors.executors;
		if (!executors.hasSnapshot) return;
		untrack(() => {
			modelCatalog.reconcileExecutors(snapshots);
			if (executorInventory.observe(snapshots)) void chatSessions.quietRefreshChats();
		});
	});
	const ghCapability = createGhCapabilityStore(executors);
	const pullRequestReviews = new PullRequestReviewsStore();
	const workspaceServices = createWorkspaceServices({
		pullRequestReviews,
		localProjectBasePath: () => remoteSettings.snapshot?.projectBasePath ?? null,
		executors,
		appShell,
		chatSessions,
		ghCapability,
		localSettings,
		modelCatalog,
		navigation,
		notifications,
		get terminalIdentity() { return terminalIdentity; },
		ws,
		chatBoardInvalidations,
		ticketsInvalidations,
		getRouteIdentity: () => page.url.pathname,
		onTerminalLauncherDismissed: () => {
			if (!terminalIdentity.clientId) return;
			setSessionStorageItem(
				SESSION_STORAGE_KEYS.terminalLauncherDismissed,
				serializeTerminalLauncherDismissal(terminalIdentity.clientId),
			);
		},
		isTerminalLauncherDismissed: () =>
			isTerminalLauncherDismissed(
				getSessionStorageItem(SESSION_STORAGE_KEYS.terminalLauncherDismissed),
				terminalIdentity.clientId,
			),
	});
	const ticketChat = new TicketChatController({
		remoteSettings,
		notifications,
		appShell,
	});
	setTicketChat(ticketChat);
	const workspaceLayout = workspaceServices.layout;
	const workspaceContext = workspaceServices.context;
	const projectResolution = workspaceServices.projectResolution;
	const terminals = workspaceServices.terminals;
	const transientLayers = workspaceServices.transientLayers;
	const surfaceFrames = workspaceServices.surfaceFrames;
	const gitQuickSummary = workspaceServices.gitQuickSummary;
	const gitMutations = workspaceServices.gitMutations;
	const gitBranchActions = workspaceServices.gitBranchActions;
	const gitReviewDisplay = workspaceServices.gitReviewDisplay;
	const gitViews = workspaceServices.gitViews;
	const singletonSurfaces = workspaceServices.singletonSurfaces;
	const fileSessions = workspaceServices.files;
	const workspace = workspaceServices.coordinator;
	const workspaceShortcuts = workspaceServices.shortcuts;
	const workbenchCommands = workspaceServices.commands;
	const minuteClock = createMinuteClockStore();
	$effect(() => {
		const presentation = terminalPresentation;
		if (presentation) untrack(() => terminals.setThemePresentation(presentation));
	});
	$effect(() => {
		const presentation = editorPresentation;
		if (presentation) untrack(() => fileSessions.setThemePresentation(presentation));
	});
	const sidebarSearch = createSidebarSearchStore({
		getChats: () => chatSessions.orderedChats,
		getSelectedChatId: () => chatSessions.selectedChatId,
		getTranscriptSearchEnabled: () =>
			remoteSettings.snapshot?.features?.transcriptSearch.enabled === true,
		getSearchResultSort: () => localSettings.sidebarSearchResultSort,
		notifyError: (message) => notifications.error(message),
		searchChatTranscripts,
		logError: (message, error) => {
			console.error(message, error);
		},
	});
	setRemoteSettings(remoteSettings);
	setScheduledPrompts(scheduledPrompts);
	setPreambles(preambles);
	setExecutors(executors);
	setChatPreambleSelectionInvalidationHub(chatPreambleSelectionInvalidationHub);
	setSnippets(snippets);
	setNavigation(navigation);
	setChatSessions(chatSessions);
	setAppShell(appShell);
	setWorkspaceLayout(workspaceLayout);
	setWorkspaceContext(workspaceContext);
	setProjectResolution(projectResolution);
	setTerminalRegistry(terminals);
	setWorkspaceCoordinator(workspace);
	setWorkspaceWindowDnd(workspaceServices.windowDnd);
	setWorkspaceHostGeometry(workspaceServices.hostGeometry);
	setTransientLayers(transientLayers);
	setSurfaceFrames(surfaceFrames);
	setWorkspaceShortcuts(workspaceShortcuts);
	setWorkbenchCommands(workbenchCommands);
	setGitQuickSummary(gitQuickSummary);
	setGitBranchActions(gitBranchActions);
	setGitMutations(gitMutations);
	setGitReviewDisplay(gitReviewDisplay);
	setGitViewLauncher(gitViews);
	setSingletonSurfaces(singletonSurfaces);
	setWs(ws);
	setChatProcessingReconciler(chatProcessingReconciler);
	setFileSessions(fileSessions);
	setReadReceiptOutbox(readReceiptOutbox);
	setModelCatalog(modelCatalog);
	setGhCapability(ghCapability);
	setPullRequestReviews(pullRequestReviews);
	setNotifications(notifications);
	setSidebarSearch(sidebarSearch);
	setSidebarProjectCollapse(sidebarProjectCollapse);
	setMinuteClock(minuteClock);

	let commandMenu = $state<{ toggle: () => void } | null>(null);

	// Connects WebSocket after authentication.
	// Uses untrack to prevent the effect from re-running when connect() mutates
	// internal $state fields (which would cause an infinite reconnect loop).
	let fileRecoveryInitialized = false;
	$effect(() => {
		if (!visible) {
			untrack(() => ws.pause('workspace-inactive'));
		} else if (auth.isAuthenticated) {
			const token = auth.token;
			const authDisabled = auth.authDisabled;
			if (!fileRecoveryInitialized) {
				const userId = untrack(() => auth.user?.id);
				if (authDisabled || userId) {
					fileRecoveryInitialized = true;
					const namespace = authDisabled ? 'local' : `user:${userId}`;
					untrack(() => {
						void fileSessions.initializeRecovery(namespace);
					});
				}
			}
			untrack(() => ws.connect(token, authDisabled));
		} else untrack(() => ws.pause('missing-auth'));
	});

	let presentationOwnerKey: string | null = null;
	$effect(() => {
		const authenticated = auth.isAuthenticated;
		const owner = auth.presentationOwner;
		const key = owner ? JSON.stringify([owner.mode, owner.key]) : null;
		untrack(() => {
			fileImages.setOwner(key);
			modelCatalog.setOwner(key);
			if (key !== presentationOwnerKey) {
				presentationOwnerKey = key;
				ticketsInvalidations.publishAuthority(authenticated);
			} else ticketsInvalidations.publishAvailability(authenticated);
		});
	});

	let terminalsInitialized = false;
	$effect(() => {
		const authenticated = auth.isAuthenticated;
		const identity = terminalIdentity;
		let current = true;
		untrack(() => {
			void identity.ready.then(async (clientId) => {
				if (!current || clientId === null || !identity.established) return;
				if (!authenticated) {
					terminals.authChanged(false);
					return;
				}
				if (!terminalsInitialized) {
					terminalsInitialized = true;
					await terminals.initialize();
					return;
				}
				terminals.authChanged(true);
			});
		});
		return () => {
			current = false;
		};
	});

	const browserNotifications = new BrowserNotificationService({
		enabled: () => visible && ws.isConnected && localSettings.browserNotifications,
		openChat: gotoChat,
		isFocused: () => document.visibilityState === 'visible' && document.hasFocus(),
	});
	const browserNotificationsRouter = new BrowserNotificationsRouter(ws, browserNotifications, {
		enabled: () => localSettings.browserNotifications,
		isFocused: () => document.visibilityState === 'visible' && document.hasFocus(),
		isChatProcessing: (id) => chatSessions.isChatProcessing(id),
		allowsNotifications: (id) => {
			const chat = chatSessions.byId[id];
			return (
				!!chat &&
				modelCatalog.forExecutor(chat.executorId).getAgent(chat.agentId)?.executionPolicy ===
					'conversation'
			);
		},
	});
	onMount(() => {
		browserNotifications.start();
		return ws.onConnectionChange((connected) => {
			if (connected) {
				void remoteSettings.refreshLatest().catch((error: unknown) =>
					console.warn('Failed to refresh remote settings on connection:', error));
			} else browserNotificationsRouter.releasePermissions();
		});
	});
	onMount(() =>
		installNativeConnectionNotification(
			ws,
			notifications,
			new URL(resolve('/'), window.location.origin),
		),
	);
	const transcriptSearchStatus = new TranscriptSearchStatusController(ws, (status) =>
		sidebarSearch.applyTranscriptSearchStatus(status),
	);
	const apiProviders = new ApiProvidersStore(() => modelCatalog.invalidateAll());
	setApiProviders(apiProviders);
	const unsubscribeWorkspaceEvents = subscribeWorkspaceEvents(ws, {
		apiProviders,
		chatBoardInvalidations,
		executors,
		preambles,
		preambleSelections: chatPreambleSelectionInvalidationHub,
		pullRequestReviews,
		remoteSettings,
		scheduledPrompts,
		snippets,
		ticketsInvalidations,
	});
	browserNotificationsRouter.start();
	transcriptSearchStatus.start();

	$effect(() => {
		const connectedAt = ws.connectionStatus.lastConnectedAt;
		if (!connectedAt) return;
		untrack(() => void transcriptSearchStatus.refresh());
		untrack(() => void scheduledPrompts.refreshIfLoaded());
		untrack(() => pullRequestReviews.invalidate());
		untrack(() => void preambles.refreshIfLoaded());
		untrack(() => void snippets.refreshIfLoaded());
		untrack(() => void executors.refresh());
		untrack(() => {
			apiProviders.invalidate();
			void modelCatalog.refreshIfStale();
		});
		// A reconnect also refreshes an already-open chat selection editor;
		// its dirty draft is preserved by the controller's refresh path.
		untrack(() => chatPreambleSelectionInvalidationHub.publishReconnect());
		untrack(() => chatBoardInvalidations.publishReconnect());
		untrack(() => ticketsInvalidations.publishReconnect());
		return () => transcriptSearchStatus.cancelRefresh();
	});

	onMount(() => {
		ws.onAuthFailure = (token, code) => {
			if (code !== 1006)
				auth.sessionRejected(
					token,
					code === AUTH_UNAVAILABLE_CLOSE_CODE
						? 'AUTH_STORAGE_UNAVAILABLE'
						: 'AUTH_SESSION_INVALID',
				);
			void auth.reconcile().then(() => {
				if (!auth.isAuthenticated) return;
				if (code === 1006) ws.retryAfterAuthProbe();
				else ws.resumeForAuth(auth.token, auth.authDisabled);
			});
		};
		const removeCompletionSoundUnlockListeners = installCompletionSoundUnlockListeners(
			() => localSettings.completionSoundMode !== 'off',
		);
		return () => {
			removeCompletionSoundUnlockListeners();
			ws.onAuthFailure = null;
		};
	});

	function handlePageHide() {
		readReceiptOutbox.flushNow();
		terminals.authChanged(false);
		terminalIdentity.destroy();
	}

	function handlePageShow(event: PageTransitionEvent) {
		if (event.persisted) terminalIdentity = new TerminalClientIdentity();
	}

	onMount(() => {
		window.addEventListener('pagehide', handlePageHide);
		window.addEventListener('pageshow', handlePageShow);
		return () => {
			window.removeEventListener('pagehide', handlePageHide);
			window.removeEventListener('pageshow', handlePageShow);
		};
	});

	// Preload remote settings after authentication so root-global values
	// (projectBasePath, etc.) are available before feature-specific fetches.
	$effect(() => {
		if (!auth.isAuthenticated) return;
		void remoteSettings.ensureLoadedInBackground();
	});

	// Preloads saved searches outside the sidebar mount lifecycle so the
	// mobile drawer opens with persistent search context already available.
	$effect(() => {
		if (!auth.isAuthenticated) return;
		untrack(() => {
			void sidebarSearch.loadSavedSearches();
		});
	});

	// Refreshes the model catalog only after auth is known, since the models
	// endpoint is protected when auth is enabled.
	$effect(() => {
		if (!auth.isAuthenticated) return;
		untrack(() => {
			void modelCatalog.refreshIfStale();
			void executors.refresh();
		});
	});

	// Keeps root-global remote values synchronized after both HTTP refreshes
	// and settings-changed WebSocket updates.
	$effect(() => {
		if (!auth.isAuthenticated) {
			if (!auth.presentationOwner) appShell.projectBasePath = '/';
			return;
		}
		const projectBasePath = remoteSettings.snapshot?.projectBasePath;
		if (!projectBasePath) return;
		appShell.projectBasePath = projectBasePath;
	});

	onDestroy(() => {
		unsubscribeWorkspaceEvents();
		modelCatalog.dispose();
		browserNotificationsRouter.destroy();
		browserNotifications.destroy();
		transcriptSearchStatus.destroy();
		ghCapability.destroy();
		fileImages.destroy();
		sidebarProjectCollapse.destroy();
		minuteClock.destroy();
		sidebarSearch.destroy();
		readReceiptOutbox.destroy();
		chatProcessingReconciler.destroy();
		ws.disconnect();
		workspaceServices.destroy();
		terminalIdentity.destroy();
	});

	const startupOnboarding = new StartupOnboardingState();
	$effect(() => {
		const decision = startupOnboarding.resolve({
			isAuthenticated: auth.isAuthenticated,
			isPublicRoute: !visible,
			logoutPending: auth.logoutPending,
			hadSavedSettingsOnLoad: localSettings.hadSavedSettingsOnLoad,
		});
		if (decision === 'open') {
			appShell.openOnboardingWizard();
		}
	});
</script>

{#if visible}
	<AppShell />
	<NativeReadySignal />

	<CommandMenu bind:this={commandMenu} />
	<KeyboardShortcuts
		authSuspended={!auth.isAuthenticated}
		onToggleCommandMenu={() => commandMenu?.toggle()}
	/>
	{#if !auth.isAuthenticated}<ReauthenticationOverlay />{/if}
{/if}
