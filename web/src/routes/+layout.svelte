<script lang="ts">
	import { BrowserNotificationsRouter } from '$lib/events/browser-notifications-router.js';
	import { BrowserNotificationService } from '$lib/notifications/browser-notifications.js';
	import { gotoChat } from '$lib/chat/actions/chat-navigation.js';
	import '../app.css';
	import { onMount, onDestroy, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { appPathname } from '$lib/deployment/paths';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import GarconMark from '$lib/components/shared/GarconMark.svelte';

	import { createAuthStore } from '$lib/stores/auth.svelte.js';
	import ReauthenticationOverlay from '$lib/components/auth/ReauthenticationOverlay.svelte';
	import { AUTH_UNAVAILABLE_CLOSE_CODE } from '$shared/ws-auth';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import { FileImageCache } from '$lib/files/images/file-image-cache.svelte.js';
	import { setFileImages } from '$lib/context/file-images-context.js';
	import { createRemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
	import { createScheduledPromptsStore } from '$lib/scheduling/scheduled-prompts-store.svelte.js';
	import { createPreamblesStore } from '$lib/preambles/preambles-store.svelte.js';
	import { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
	import { ExecutorInventoryChanges } from '$lib/executors/executor-inventory-changes.js';
	import { ExecutorsRouter } from '$lib/events/executors-router.js';
	import { ApiProvidersRouter } from '$lib/events/api-providers-router.js';
	import { ApiProvidersStore } from '$lib/api-providers/api-providers-store.svelte.js';
	import { createChatPreambleSelectionInvalidationHub } from '$lib/preambles/chat-selection-invalidation-hub.js';
	import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
	import { createAppTitleStore } from '$lib/stores/app-title.js';
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
	import { projectOverlayBackdropEffects } from '$lib/overlays/backdrop-effects.js';
	import { createSidebarSearchStore } from '$lib/sidebar/search/sidebar-search-store.svelte.js';
	import { createGhCapabilityStore } from '$lib/git/pull-requests/gh-capability.svelte.js';
	import { PullRequestReviewsStore } from '$lib/git/pull-requests/pull-request-reviews-store.svelte.js';
	import { PullRequestReviewsRouter } from '$lib/events/pull-request-reviews-router.js';
	import { createSidebarProjectCollapseStore } from '$lib/sidebar/projects/sidebar-project-collapse.svelte.js';
	import { resolveFirstRegistrationOnboarding } from '$lib/onboarding/first-registration-onboarding.js';
	import {
		setAuth,
		setNavigation,
		setChatSessions,
		setAppShell,
		setWs,
		setChatProcessingReconciler,
		setFileSessions,
		setReadReceiptOutbox,
		setModelCatalog,
		setLocalSettings,
		setRemoteSettings,
		setNotifications,
		setSidebarSearch,
		setSidebarProjectCollapse,
		setAppTitle,
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
		setThemeRuntime,
	} from '$lib/context';
	import { RemoteSettingsRouter } from '$lib/events/remote-settings-router.js';
	import { TranscriptSearchStatusController } from '$lib/events/transcript-search-status-controller.js';
	import { ScheduledPromptsRouter } from '$lib/events/scheduled-prompts-router.js';
	import { PreamblesRouter } from '$lib/events/preambles-router.js';
	import { SnippetsRouter } from '$lib/events/snippets-router.js';
	import AppShell from '$lib/components/layout/AppShell.svelte';
	import CommandMenu from '$lib/components/shared/CommandMenu.svelte';
	import KeyboardShortcuts from '$lib/components/shared/KeyboardShortcuts.svelte';
	import { searchChatTranscripts } from '$lib/api/chats';
	import * as m from '$lib/paraglide/messages.js';
	import {
		getLocalStorageItem,
		getSessionStorageItem,
		LOCAL_STORAGE_KEYS,
		removeLocalStorageItem,
		SESSION_STORAGE_KEYS,
		setSessionStorageItem,
	} from '$lib/utils/local-persistence';
	import { TerminalClientIdentity } from '$lib/workspace/terminal-client-identity.svelte.js';
	import {
		isTerminalLauncherDismissed,
		serializeTerminalLauncherDismissal,
	} from '$lib/workspace/terminal-launcher-dismissal.js';
	import { createWorkspaceServices } from '$lib/workspace/workspace-services.js';
	import { ThemeController } from '$lib/theme/theme-controller.svelte.js';
	import { createChatBoardInvalidationHub } from '$lib/chat-board/catalog/chat-board-invalidation-hub.js';
	import { ChatBoardsRouter } from '$lib/events/chat-boards-router.js';
	import { TicketsRouter } from '$lib/events/tickets-router.js';
	import { TicketsInvalidationHub } from '$lib/tickets/catalog/tickets-invalidation-hub.js';
	import { setTicketChat, setTicketsInvalidations } from '$lib/context/tickets-context.js';
	import { TicketChatController } from '$lib/tickets/chat/ticket-chat-controller.svelte.js';

	let { children } = $props();

	const auth = createAuthStore();
	const terminalIdentity = new TerminalClientIdentity();
	const localSettings = createLocalSettingsStore();
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
	const appTitle = createAppTitleStore();
	const navigation = createNavigationStore();
	const notifications = createNotificationsStore();
	const chatSessions = createChatSessionsStore({
		notifyError: (message) => notifications.error(message),
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
		terminalIdentity,
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
	const sidebarProjectCollapse = createSidebarProjectCollapseStore();
	const minuteClock = createMinuteClockStore();
	const themeController = new ThemeController({
		getPreference: () => localSettings.themePreference,
		setTerminalPresentation: (presentation) => terminals.setThemePresentation(presentation),
		setEditorPresentation: (presentation) => fileSessions.setThemePresentation(presentation),
		reportError: (message) => console.error(message),
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
	setAuth(auth);
	setLocalSettings(localSettings);
	setRemoteSettings(remoteSettings);
	setScheduledPrompts(scheduledPrompts);
	setPreambles(preambles);
	setExecutors(executors);
	setChatPreambleSelectionInvalidationHub(chatPreambleSelectionInvalidationHub);
	setSnippets(snippets);
	setAppTitle(appTitle);
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
	setThemeRuntime(themeController);

	const publicRoutes = ['/login', '/setup'];
	const isAuthRoute = $derived(publicRoutes.includes(appPathname(page.url.pathname)));
	let isPublicRoute = $derived(isAuthRoute || page.route.id === '/shared/[token]');

	let commandMenu = $state<{ toggle: () => void } | null>(null);
	// Projects presentation-only bounds without coupling Markdown loading to settings.
	$effect(() => {
		const root = document.documentElement;
		root.dataset.inlineImageThumbnailSize = localSettings.inlineImageThumbnailSize;
		return () => {
			delete root.dataset.inlineImageThumbnailSize;
		};
	});

	$effect(() => {
		const root = document.documentElement;
		root.dataset.inlineMermaidThumbnailSize = localSettings.inlineMermaidThumbnailSize;
		return () => {
			delete root.dataset.inlineMermaidThumbnailSize;
		};
	});

	// Projects the browser-local backdrop preference to portal-rendered overlays.
	$effect(() => {
		return projectOverlayBackdropEffects(
			document.documentElement,
			localSettings.overlayBackdropEffects,
		);
	});

	// Connects WebSocket after authentication.
	// Uses untrack to prevent the effect from re-running when connect() mutates
	// internal $state fields (which would cause an infinite reconnect loop).
	let fileRecoveryInitialized = false;
	$effect(() => {
		if (auth.isAuthenticated) {
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
		} else untrack(() => ws.pauseForAuth());
	});

	let presentationOwnerKey: string | null = null;
	$effect(() => {
		const authenticated = auth.isAuthenticated;
		const owner = auth.presentationOwner;
		const key = owner ? JSON.stringify([owner.mode, owner.key]) : null;
		untrack(() => {
			fileImages.setOwner(key);
			if (key !== presentationOwnerKey) {
				presentationOwnerKey = key;
				ticketsInvalidations.publishAuthority(authenticated);
			} else ticketsInvalidations.publishAvailability(authenticated);
		});
	});

	let terminalsInitialized = false;
	$effect(() => {
		const authenticated = auth.isAuthenticated;
		untrack(() => {
			void terminalIdentity.ready.then(async () => {
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
	});

	const browserNotifications = new BrowserNotificationService({
		enabled: () => localSettings.browserNotifications,
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
			if (!connected) browserNotificationsRouter.clearPermissions();
		});
	});
	// Pushes settings-changed WebSocket messages into the remote store.
	const settingsRouter = new RemoteSettingsRouter(ws, remoteSettings);
	const transcriptSearchStatus = new TranscriptSearchStatusController(ws, (status) =>
		sidebarSearch.applyTranscriptSearchStatus(status),
	);
	const scheduledPromptsRouter = new ScheduledPromptsRouter(ws, scheduledPrompts);
	const pullRequestReviewsRouter = new PullRequestReviewsRouter(ws, pullRequestReviews);
	const preamblesRouter = new PreamblesRouter(ws, preambles, chatPreambleSelectionInvalidationHub);
	const snippetsRouter = new SnippetsRouter(ws, snippets);
	const executorsRouter = new ExecutorsRouter(ws, executors);
	const apiProviders = new ApiProvidersStore(() => modelCatalog.invalidateAll());
	setApiProviders(apiProviders);
	const apiProvidersRouter = new ApiProvidersRouter(ws, apiProviders);
	const chatBoardsRouter = new ChatBoardsRouter(ws, chatBoardInvalidations);
	const ticketsRouter = new TicketsRouter(ws, ticketsInvalidations);
	browserNotificationsRouter.start();
	settingsRouter.start();
	transcriptSearchStatus.start();
	scheduledPromptsRouter.start();
	pullRequestReviewsRouter.start();
	preamblesRouter.start();
	snippetsRouter.start();
	executorsRouter.start();
	apiProvidersRouter.start();
	chatBoardsRouter.start();
	ticketsRouter.start();
	$effect(() => {
		ws.messageVersion;
		browserNotificationsRouter.tick();
		settingsRouter.tick();
		transcriptSearchStatus.tick();
		scheduledPromptsRouter.tick();
		pullRequestReviewsRouter.tick();
		preamblesRouter.tick();
		snippetsRouter.tick();
		executorsRouter.tick();
		apiProvidersRouter.tick();
		chatBoardsRouter.tick();
		ticketsRouter.tick();
	});

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
		auth.start();
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
		void auth.checkAuthStatus();
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
	}

	onMount(() => {
		window.addEventListener('pagehide', handlePageHide);
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
		auth.destroy();
		window.removeEventListener('pagehide', handlePageHide);
		browserNotificationsRouter.destroy();
		browserNotifications.destroy();
		settingsRouter.destroy();
		transcriptSearchStatus.destroy();
		scheduledPromptsRouter.destroy();
		pullRequestReviewsRouter.destroy();
		preamblesRouter.destroy();
		snippetsRouter.destroy();
		executorsRouter.destroy();
		apiProvidersRouter.destroy();
		ghCapability.destroy();
		chatBoardsRouter.destroy();
		ticketsRouter.destroy();
		localSettings.destroy();
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

	// Redirects unauthenticated users, checks onboarding status.
	// Also guards /setup when account already exists.
	$effect(() => {
		if (auth.logoutPending) return;
		if (auth.isLoading) return;
		if (auth.authDisabled) return;
		if (auth.isUnavailable) return;
		if (auth.presentationOwner) return;

		if (page.route.id === '/setup' && !auth.needsSetup && !auth.isAuthenticated) {
			goto(resolve('/login'));
			return;
		}

		if (isPublicRoute) return;
		if (auth.needsSetup) {
			goto(resolve('/setup'));
		} else if (!auth.isAuthenticated) {
			const returnTo = appPathname(page.url.pathname) + page.url.search + page.url.hash;
			goto(
				resolve('/login') + (returnTo === '/' ? '' : `?returnTo=${encodeURIComponent(returnTo)}`),
			);
		}
	});

	// Redirects authenticated users away from login/setup routes.
	// Shared view routes are excluded -- they are public by design.
	$effect(() => {
		if (auth.isLoading) return;
		if (auth.isUnavailable) return;
		if (!isPublicRoute) return;
		if (page.route.id === '/shared/[token]') return;
		if (auth.authDisabled || (auth.isAuthenticated && !auth.needsSetup)) {
			goto(resolve('/'));
		}
	});

	// Opens the onboarding wizard on the first authenticated load right after
	// a successful registration. Gated on a persisted flag set during the
	// registration flow so cold loads for existing users or auth-disabled
	// sessions do not receive a blocking onboarding modal.
	let onboardingAutoOpened = $state(false);
	$effect(() => {
		if (onboardingAutoOpened) return;
		const decision = resolveFirstRegistrationOnboarding({
			isLoading: auth.isLoading,
			isAuthenticated: auth.isAuthenticated,
			authDisabled: auth.authDisabled,
			isRegistrationRoute: page.route.id === '/setup',
			justRegistered: getLocalStorageItem(LOCAL_STORAGE_KEYS.justRegistered) === '1',
		});
		if (decision === 'wait') return;
		onboardingAutoOpened = true;
		if (decision === 'open') {
			removeLocalStorageItem(LOCAL_STORAGE_KEYS.justRegistered);
			appShell.openOnboardingWizard();
		}
	});
</script>

{#if auth.logoutPending}
	<div class="min-h-dvh bg-background flex items-center justify-center p-4">
		<p role="status" class="text-muted-foreground">{m.auth_logging_out()}</p>
	</div>
{:else if !auth.presentationOwner && auth.isLoading && (!isPublicRoute || auth.token)}
	<div class="min-h-dvh bg-background flex items-center justify-center p-4">
		<div class="text-center">
			<div class="flex justify-center mb-4">
				<GarconMark class="size-16 shadow-sm" />
			</div>
			<h1 class="text-2xl font-bold text-foreground mb-2">{m.sidebar_app_title()}</h1>
			<div class="flex items-center justify-center space-x-2">
				<div class="w-2 h-2 bg-status-processing rounded-full animate-bounce"></div>
				<div
					class="w-2 h-2 bg-status-processing rounded-full animate-bounce"
					style="animation-delay: 0.1s"
				></div>
				<div
					class="w-2 h-2 bg-status-processing rounded-full animate-bounce"
					style="animation-delay: 0.2s"
				></div>
			</div>
			<p class="text-muted-foreground mt-2">{m.status_loading()}</p>
		</div>
	</div>
{:else if !auth.presentationOwner && auth.isUnavailable && (!isPublicRoute || auth.token || (isAuthRoute && auth.availability === 'storage-unavailable'))}
	<div data-auth-recovery class="min-h-dvh bg-background flex items-center justify-center p-4">
		<div class="max-w-md text-center">
			<div class="flex justify-center mb-4">
				<GarconMark class="size-16 shadow-sm" />
			</div>
			<h1 class="text-2xl font-bold text-foreground mb-2">{m.auth_reconnecting_title()}</h1>
			<p class="text-muted-foreground mb-4">
				{auth.availability === 'storage-unavailable'
					? m.auth_storage_unavailable()
					: auth.token
						? m.auth_reconnecting_session_description()
						: m.auth_reconnecting_description()}
			</p>
			{#if auth.availability !== 'storage-unavailable'}<Button
					onclick={() => auth.checkAuthStatus()}
					disabled={auth.isLoading}
				>
					{m.common_retry()}
				</Button>{/if}
		</div>
	</div>
{:else if isPublicRoute}
	{@render children()}
{:else if auth.presentationOwner}
	<AppShell />

	<CommandMenu bind:this={commandMenu} />
	<KeyboardShortcuts
		authSuspended={!auth.isAuthenticated}
		onToggleCommandMenu={() => commandMenu?.toggle()}
	/>
	{#if !auth.isAuthenticated}<ReauthenticationOverlay />{/if}
{/if}
