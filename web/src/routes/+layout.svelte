<script lang="ts">
	import '../app.css';
	import { onMount, onDestroy, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import { Button } from '$lib/components/ui/button/index.js';

	import { createAuthStore } from '$lib/stores/auth.svelte.js';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import { createRemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
	import { createScheduledPromptsStore } from '$lib/scheduling/scheduled-prompts-store.svelte.js';
	import { createPreamblesStore } from '$lib/preambles/preambles-store.svelte.js';
	import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
	import { createAppTitleStore } from '$lib/stores/app-title.svelte.js';
	import { createMinuteClockStore } from '$lib/stores/minute-clock.svelte.js';
	import { createNavigationStore } from '$lib/stores/navigation.svelte.js';
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
	import { createGhCapabilityStore } from '$lib/stores/gh-capability.svelte.js';
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
		setScheduledPrompts,
		setPreambles,
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
		setGitQuickSummary,
		setGitBranchActions,
		setGitMutations,
		setGitReviewDisplay,
		setGitViewLauncher,
		setSingletonSurfaces,
	} from '$lib/context';
	import { RemoteSettingsRouter } from '$lib/events/remote-settings-router.svelte.js';
	import { TranscriptSearchStatusRouter } from '$lib/events/transcript-search-status-router.svelte.js';
	import { ScheduledPromptsRouter } from '$lib/events/scheduled-prompts-router.svelte.js';
	import { PreamblesRouter } from '$lib/events/preambles-router.svelte.js';
	import { SnippetsRouter } from '$lib/events/snippets-router.svelte.js';
	import AppShell from '$lib/components/layout/AppShell.svelte';
	import CommandMenu from '$lib/components/shared/CommandMenu.svelte';
	import KeyboardShortcuts from '$lib/components/shared/KeyboardShortcuts.svelte';
	import { getTranscriptSearchStatus, searchChatTranscripts } from '$lib/api/chats';
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

	let { children } = $props();

	const auth = createAuthStore();
	const terminalIdentity = new TerminalClientIdentity();
	const localSettings = createLocalSettingsStore();
	const remoteSettings = createRemoteSettingsStore();
	const scheduledPrompts = createScheduledPromptsStore();
	const preambles = createPreamblesStore();
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
	const ghCapability = createGhCapabilityStore();
	const workspaceServices = createWorkspaceServices({
		appShell,
		chatSessions,
		ghCapability,
		localSettings,
		modelCatalog,
		navigation,
		notifications,
		terminalIdentity,
		ws,
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
	const sidebarProjectCollapse = createSidebarProjectCollapseStore();
	const minuteClock = createMinuteClockStore();
	const sidebarSearch = createSidebarSearchStore({
		getChats: () => chatSessions.orderedChats,
		getSelectedChatId: () => chatSessions.selectedChatId,
		getTranscriptSearchEnabled: () =>
			remoteSettings.snapshot?.features?.transcriptSearch.enabled === true,
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
	setNotifications(notifications);
	setSidebarSearch(sidebarSearch);
	setSidebarProjectCollapse(sidebarProjectCollapse);
	setMinuteClock(minuteClock);

	const publicRoutes = ['/login', '/setup'];
	let isPublicRoute = $derived(
		publicRoutes.includes(page.url.pathname) || page.url.pathname.startsWith('/shared/'),
	);

	let commandMenu = $state<{ toggle: () => void } | null>(null);
	const DARK_THEME_COLOR = '#0c1117';
	const LIGHT_THEME_COLOR = '#ffffff';

	function applyThemeDom(isDark: boolean): void {
		terminals.setDarkTheme(isDark);
		document.documentElement.classList.toggle('dark', isDark);
		document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
		fileSessions.setDarkTheme(isDark);

		const statusBarMeta = document.querySelector(
			'meta[name="apple-mobile-web-app-status-bar-style"]',
		);
		statusBarMeta?.setAttribute('content', isDark ? 'black-translucent' : 'default');

		const themeColor = isDark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
		const themeColorMetas = document.querySelectorAll('meta[name="theme-color"]');
		themeColorMetas.forEach((meta) => meta.setAttribute('content', themeColor));
	}

	// Applies theme class to document element. When 'system', listens for
	// OS-level preference changes (e.g. Dark Reader or system toggle).
	$effect(() => {
		const theme = localSettings.theme;
		if (theme !== 'system') {
			applyThemeDom(theme === 'dark');
			return;
		}
		const mql = window.matchMedia('(prefers-color-scheme: dark)');
		applyThemeDom(mql.matches);
		function onChange(e: MediaQueryListEvent) {
			applyThemeDom(e.matches);
		}
		mql.addEventListener('change', onChange);
		return () => mql.removeEventListener('change', onChange);
	});

	// Toggles colorblind-friendly color overrides on the root element.
	$effect(() => {
		document.documentElement.classList.toggle('colorblind', localSettings.colorblindMode);
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
	$effect(() => {
		if (auth.isAuthenticated) {
			const token = auth.token;
			const authDisabled = auth.authDisabled;
			untrack(() => ws.connect(token, authDisabled));
		}
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

	// Pushes settings-changed WebSocket messages into the remote store.
	const settingsRouter = new RemoteSettingsRouter(ws, remoteSettings);
	const transcriptSearchStatusRouter = new TranscriptSearchStatusRouter(ws, (status) =>
		sidebarSearch.applyTranscriptSearchStatus(status),
	);
	const scheduledPromptsRouter = new ScheduledPromptsRouter(ws, scheduledPrompts);
	const preamblesRouter = new PreamblesRouter(ws, preambles);
	const snippetsRouter = new SnippetsRouter(ws, snippets);
	settingsRouter.start();
	transcriptSearchStatusRouter.start();
	scheduledPromptsRouter.start();
	preamblesRouter.start();
	snippetsRouter.start();
	$effect(() => {
		ws.messageVersion;
		settingsRouter.tick();
		transcriptSearchStatusRouter.tick();
		scheduledPromptsRouter.tick();
		preamblesRouter.tick();
		snippetsRouter.tick();
	});

	$effect(() => {
		const connectedAt = ws.connectionStatus.lastConnectedAt;
		if (!connectedAt) return;
		untrack(() => {
			void getTranscriptSearchStatus()
				.then((status) => sidebarSearch.applyTranscriptSearchStatus(status))
				.catch(() => undefined);
		});
		untrack(() => void scheduledPrompts.refreshIfLoaded());
		untrack(() => void preambles.refreshIfLoaded());
		untrack(() => void snippets.refreshIfLoaded());
	});

	onMount(() => {
		void auth.checkAuthStatus();
		const removeCompletionSoundUnlockListeners = installCompletionSoundUnlockListeners(
			() => localSettings.completionSoundMode !== 'off',
		);
		const handleOnline = () => {
			if (auth.isUnavailable) void auth.checkAuthStatus();
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible' && auth.isUnavailable) {
				void auth.checkAuthStatus();
			}
		};
		const retryInterval = window.setInterval(() => {
			if (document.visibilityState === 'visible' && auth.isUnavailable) {
				void auth.checkAuthStatus();
			}
		}, 15_000);
		window.addEventListener('online', handleOnline);
		document.addEventListener('visibilitychange', handleVisibilityChange);
		return () => {
			removeCompletionSoundUnlockListeners();
			window.clearInterval(retryInterval);
			window.removeEventListener('online', handleOnline);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
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
		});
	});

	// Checks host GitHub CLI readiness once after app authentication.
	$effect(() => {
		if (!auth.isAuthenticated) return;
		untrack(() => {
			void ghCapability.ensureChecked();
		});
	});

	// Keeps root-global remote values synchronized after both HTTP refreshes
	// and settings-changed WebSocket updates.
	$effect(() => {
		if (!auth.isAuthenticated) {
			appShell.projectBasePath = '/';
			return;
		}
		const projectBasePath = remoteSettings.snapshot?.projectBasePath;
		if (!projectBasePath) return;
		appShell.projectBasePath = projectBasePath;
	});

	onDestroy(() => {
		window.removeEventListener('pagehide', handlePageHide);
		settingsRouter.destroy();
		transcriptSearchStatusRouter.destroy();
		scheduledPromptsRouter.destroy();
		preamblesRouter.destroy();
		snippetsRouter.destroy();
		localSettings.destroy();
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
		if (auth.isLoading) return;
		if (auth.authDisabled) return;
		if (auth.isUnavailable) return;

		if (page.url.pathname === '/setup' && !auth.needsSetup && !auth.isAuthenticated) {
			goto('/login');
			return;
		}

		if (isPublicRoute) return;
		if (auth.needsSetup) {
			goto('/setup');
		} else if (!auth.isAuthenticated) {
			const returnTo = page.url.pathname;
			goto(returnTo === '/' ? '/login' : `/login?returnTo=${encodeURIComponent(returnTo)}`);
		}
	});

	// Redirects authenticated users away from login/setup routes.
	// Shared view routes are excluded -- they are public by design.
	$effect(() => {
		if (auth.isLoading) return;
		if (auth.isUnavailable) return;
		if (!isPublicRoute) return;
		if (page.url.pathname.startsWith('/shared/')) return;
		if (auth.authDisabled || (auth.isAuthenticated && !auth.needsSetup)) {
			goto('/');
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
			isRegistrationRoute: page.url.pathname === '/setup',
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

{#if auth.isLoading && (!isPublicRoute || auth.token)}
	<div class="min-h-dvh bg-background flex items-center justify-center p-4">
		<div class="text-center">
			<div class="flex justify-center mb-4">
				<div class="w-16 h-16 bg-primary rounded-lg flex items-center justify-center shadow-sm">
					<MessageSquare class="w-8 h-8 text-primary-foreground" />
				</div>
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
{:else if auth.isUnavailable && (!isPublicRoute || auth.token)}
	<div data-auth-recovery class="min-h-dvh bg-background flex items-center justify-center p-4">
		<div class="max-w-md text-center">
			<div class="flex justify-center mb-4">
				<div class="w-16 h-16 bg-primary rounded-lg flex items-center justify-center shadow-sm">
					<MessageSquare class="w-8 h-8 text-primary-foreground" />
				</div>
			</div>
			<h1 class="text-2xl font-bold text-foreground mb-2">{m.auth_reconnecting_title()}</h1>
			<p class="text-muted-foreground mb-4">
				{auth.token ? m.auth_reconnecting_session_description() : m.auth_reconnecting_description()}
			</p>
			<Button onclick={() => auth.checkAuthStatus()} disabled={auth.isLoading}>
				{m.common_retry()}
			</Button>
		</div>
	</div>
{:else if isPublicRoute}
	{@render children()}
{:else if auth.isAuthenticated}
	<AppShell />

	<CommandMenu bind:this={commandMenu} />
	<KeyboardShortcuts onToggleCommandMenu={() => commandMenu?.toggle()} />
{/if}
