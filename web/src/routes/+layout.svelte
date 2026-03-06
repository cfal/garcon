<script lang="ts">
	import '../app.css';
	import { onMount, onDestroy, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import MessageSquare from '@lucide/svelte/icons/message-square';

	import { createAuthStore } from '$lib/stores/auth.svelte.js';
	import { createPreferencesStore } from '$lib/stores/preferences.svelte.js';
	import { createNavigationStore } from '$lib/stores/navigation.svelte.js';
	import { createChatRuntimeStore } from '$lib/stores/chat-runtime.svelte.js';
	import { createChatSessionsStore } from '$lib/stores/chat-sessions.svelte.js';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte.js';
	import { createWsConnection } from '$lib/ws/connection.svelte.js';
	import { createFileViewerStore } from '$lib/stores/file-viewer.svelte.js';
	import { createReadReceiptOutbox } from '$lib/stores/read-receipt-outbox.svelte.js';
	import { createModelCatalogStore } from '$lib/stores/model-catalog.svelte.js';
	import { setAuth, setPreferences, setNavigation, setChatRuntime, setChatSessions, setAppShell, setWs, setFileViewer, setReadReceiptOutbox, setModelCatalog } from '$lib/context';
	import AppShell from '$lib/components/layout/AppShell.svelte';
	import CommandMenu from '$lib/components/shared/CommandMenu.svelte';
	import KeyboardShortcuts from '$lib/components/shared/KeyboardShortcuts.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let { children } = $props();

	const auth = createAuthStore();
	const preferences = createPreferencesStore();
	const navigation = createNavigationStore();
	const chatRuntime = createChatRuntimeStore();
	const chatSessions = createChatSessionsStore();
	const appShell = createAppShellStore();
	const ws = createWsConnection();
	const fileViewer = createFileViewerStore();
	const readReceiptOutbox = createReadReceiptOutbox(chatSessions);
	const modelCatalog = createModelCatalogStore();

	setAuth(auth);
	setPreferences(preferences);
	setNavigation(navigation);
	setChatRuntime(chatRuntime);
	setChatSessions(chatSessions);
	setAppShell(appShell);
	setWs(ws);
	setFileViewer(fileViewer);
	setReadReceiptOutbox(readReceiptOutbox);
	setModelCatalog(modelCatalog);

	const publicRoutes = ['/login', '/setup'];
	let isPublicRoute = $derived(publicRoutes.includes(page.url.pathname));

	let commandMenu = $state<{ toggle: () => void } | null>(null);
	const DARK_THEME_COLOR = '#0c1117';
	const LIGHT_THEME_COLOR = '#ffffff';

	function applyThemeDom(isDark: boolean): void {
		document.documentElement.classList.toggle('dark', isDark);
		document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';

		const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
		statusBarMeta?.setAttribute('content', isDark ? 'black-translucent' : 'default');

		const themeColor = isDark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
		const themeColorMetas = document.querySelectorAll('meta[name="theme-color"]');
		themeColorMetas.forEach((meta) => meta.setAttribute('content', themeColor));
	}

	// Applies theme class to document element. When 'system', listens for
	// OS-level preference changes (e.g. Dark Reader or system toggle).
	$effect(() => {
		const theme = preferences.theme;
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

	onMount(() => {
		auth.checkAuthStatus();
		void modelCatalog.refreshIfStale();
	});

	function handlePageHide() {
		readReceiptOutbox.flushNow();
	}

	onMount(() => {
		window.addEventListener('pagehide', handlePageHide);
	});

	onDestroy(() => {
		window.removeEventListener('pagehide', handlePageHide);
		readReceiptOutbox.destroy();
		ws.disconnect();
	});

	// Redirects unauthenticated users, checks onboarding status
	$effect(() => {
		if (auth.isLoading) return;
		if (isPublicRoute) return;
		if (auth.authDisabled) return;
		if (auth.needsSetup) {
			goto('/setup');
		} else if (!auth.isAuthenticated) {
			goto('/login');
		}
	});

	// Redirects authenticated users away from public routes
	$effect(() => {
		if (auth.isLoading) return;
		if (!isPublicRoute) return;
		if (auth.authDisabled || (auth.isAuthenticated && !auth.needsSetup)) {
			goto('/');
		}
	});

	// Opens the settings dialog to the Agents tab on first authenticated load
	// after registration. Uses a localStorage flag to avoid re-opening.
	let settingsAutoOpened = $state(false);
	$effect(() => {
		if (auth.isLoading || !auth.isAuthenticated || settingsAutoOpened) return;
		settingsAutoOpened = true;
		try {
			if (!localStorage.getItem('has-seen-settings')) {
				localStorage.setItem('has-seen-settings', '1');
				appShell.openSettings('agents');
			}
		} catch {
			// localStorage unavailable
		}
	});
</script>

{#if auth.isLoading && !isPublicRoute}
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
				<div class="w-2 h-2 bg-status-processing rounded-full animate-bounce" style="animation-delay: 0.1s"></div>
				<div class="w-2 h-2 bg-status-processing rounded-full animate-bounce" style="animation-delay: 0.2s"></div>
			</div>
			<p class="text-muted-foreground mt-2">{m.status_loading()}</p>
		</div>
	</div>
{:else if isPublicRoute}
	{@render children()}
{:else if auth.isAuthenticated}
	<AppShell />

	<CommandMenu bind:this={commandMenu} />
	<KeyboardShortcuts onToggleCommandMenu={() => commandMenu?.toggle()} />
{/if}
