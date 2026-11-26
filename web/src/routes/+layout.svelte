<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import GarconMark from '$lib/components/shared/GarconMark.svelte';
	import FontPreloads from '$lib/components/layout/FontPreloads.svelte';
	import NativeReadySignal from '$lib/components/layout/NativeReadySignal.svelte';
	import { setAppTitle, setAuth, setLocalSettings, setThemeRuntime } from '$lib/context';
	import { appPathname } from '$lib/deployment/paths';
	import { projectOverlayBackdropEffects } from '$lib/overlays/backdrop-effects.js';
	import { createAppTitleStore } from '$lib/stores/app-title.js';
	import { createAuthStore } from '$lib/stores/auth.svelte.js';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import { ThemeController, type ThemeControllerDeps } from '$lib/theme/theme-controller.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	let { children } = $props();

	const auth = createAuthStore();
	const localSettings = createLocalSettingsStore();
	setAppTitle(createAppTitleStore());
	setAuth(auth);
	setLocalSettings(localSettings);

	let terminalPresentation = $state.raw<
		Parameters<ThemeControllerDeps['setTerminalPresentation']>[0] | null
	>(null);
	let editorPresentation = $state.raw<
		Parameters<ThemeControllerDeps['setEditorPresentation']>[0] | null
	>(null);
	setThemeRuntime(
		new ThemeController({
			getPreference: () => localSettings.themePreference,
			getTerminalAppearance: () => localSettings.terminalAppearance,
			typography: localSettings,
			setTerminalPresentation: (presentation) => (terminalPresentation = presentation),
			setEditorPresentation: (presentation) => (editorPresentation = presentation),
			reportError: (message) => console.error(message),
		}),
	);

	onMount(() => {
		auth.start();
		void auth.checkAuthStatus();
		return () => {
			auth.destroy();
			localSettings.destroy();
		};
	});

	const isAuthRoute = $derived(['/login', '/setup'].includes(appPathname(page.url.pathname)));
	const isPublicRoute = $derived(isAuthRoute || page.route.id === '/shared/[token]');
	let workspaceBoot = $state.raw<Promise<typeof import('./WorkspaceBoot.svelte')> | null>(null);

	$effect(() => {
		if (!workspaceBoot && !isPublicRoute && auth.presentationOwner && !auth.logoutPending) {
			workspaceBoot = import('./WorkspaceBoot.svelte');
		}
	});

	$effect(() => {
		const root = document.documentElement;
		root.toggleAttribute('data-reduce-motion', localSettings.reduceMotion);
		return () => root.removeAttribute('data-reduce-motion');
	});

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
</script>

<FontPreloads typography={localSettings} />

{#snippet loading()}
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
{/snippet}

{#if auth.logoutPending}
	<div class="min-h-dvh bg-background flex items-center justify-center p-4">
		<p role="status" class="text-muted-foreground">{m.auth_logging_out()}</p>
	</div>
{:else if !auth.presentationOwner && auth.isLoading && (!isPublicRoute || auth.token)}
	{@render loading()}
{:else if !auth.presentationOwner && auth.isUnavailable && (!isPublicRoute || auth.token || (isAuthRoute && auth.availability === 'storage-unavailable'))}
	<NativeReadySignal />
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
	<NativeReadySignal />
{:else if auth.presentationOwner && !workspaceBoot}
	{@render loading()}
{/if}

{#if workspaceBoot && auth.presentationOwner && !auth.logoutPending}
	{#await workspaceBoot}
		{#if !isPublicRoute}{@render loading()}{/if}
	{:then { default: WorkspaceBoot }}
		<WorkspaceBoot visible={!isPublicRoute} {terminalPresentation} {editorPresentation} />
	{:catch error}
		{#if !isPublicRoute}
			<div class="min-h-dvh grid place-content-center gap-4 p-4 text-center">
				<NativeReadySignal />
				<h1 class="text-xl font-semibold">{m.error_unexpected()}</h1>
				<p role="alert" class="text-muted-foreground">{m.error_unexpected_description()}</p>
				<Button
					onclick={() => {
						console.error(error);
						window.location.reload();
					}}
				>
					{m.common_retry()}
				</Button>
			</div>
		{/if}
	{/await}
{/if}
