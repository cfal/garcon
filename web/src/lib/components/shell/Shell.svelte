<script lang="ts">
	// Terminal shell component backed by xterm.js and a server-side PTY via WebSocket.
	// Rendering shell only; all runtime logic lives in ShellRuntime.

	import { onMount, onDestroy } from 'svelte';
	import '@xterm/xterm/css/xterm.css';
	import { ShellRuntime } from './shell-runtime.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface ShellProps {
		projectPath: string | null;
		chatId?: string | null;
		initialCommand?: string;
		onProcessComplete?: (exitCode: number) => void;
		minimal?: boolean;
	}

	let {
		projectPath,
		chatId = null,
		initialCommand,
		onProcessComplete,
		minimal = false
	}: ShellProps = $props();

	let terminalEl = $state<HTMLDivElement>(undefined!);

	// Tracks effective dark/light mode from the root element class.
	let isDark = $state(document.documentElement.classList.contains('dark'));

	const runtime = new ShellRuntime({
		get initialCommand() { return initialCommand; },
		get onProcessComplete() { return onProcessComplete; },
		get minimal() { return minimal; },
		get isDark() { return isDark; },
	});

	let chatDisplayNameShort = $derived(chatId ? chatId.slice(0, 8) : null);

	export function restartShell(): void {
		runtime.restartShell();
	}

	// Observes dark class on <html> to keep the terminal theme in sync.
	$effect(() => {
		const root = document.documentElement;
		const observer = new MutationObserver(() => {
			isDark = root.classList.contains('dark');
		});
		observer.observe(root, { attributes: true, attributeFilter: ['class'] });
		return () => observer.disconnect();
	});

	// Applies theme to the terminal when isDark changes.
	$effect(() => {
		void isDark;
		runtime.applyTheme();
	});

	// Re-initialize when the restart cycle finishes
	$effect(() => {
		if (runtime.needsInit && projectPath && terminalEl) {
			runtime.initTerminal(terminalEl, projectPath, chatId ?? null);
		}
	});

	onMount(() => {
		// Inject xterm focus-outline suppression style
		if (typeof document !== 'undefined') {
			const id = 'xterm-outline-fix';
			if (!document.getElementById(id)) {
				const style = document.createElement('style');
				style.id = id;
				style.textContent = `.xterm .xterm-screen { outline: none !important; } .xterm:focus .xterm-screen { outline: none !important; } .xterm-screen:focus { outline: none !important; }`;
				document.head.appendChild(style);
			}
		}
		if (projectPath && terminalEl && runtime.needsInit) {
			runtime.initTerminal(terminalEl, projectPath, chatId ?? null);
		}
	});

	onDestroy(() => {
		runtime.cleanup();
	});
</script>

{#if !projectPath}
	<div class="h-full flex items-center justify-center">
		<div class="text-center text-muted-foreground">
			<div class="w-16 h-16 mx-auto mb-4 bg-muted rounded-full flex items-center justify-center">
				<svg class="w-8 h-8 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" />
				</svg>
			</div>
			<h3 class="text-lg font-semibold mb-2">{m.shell_select_project()}</h3>
			<p>{m.shell_open_chat_for_shell()}</p>
		</div>
	</div>
{:else if minimal}
	<div class="h-full w-full bg-terminal-bg relative">
		<div bind:this={terminalEl} class="h-full w-full outline-none focus-visible:ring-2 focus-visible:ring-ring" style="outline: none;"></div>
	</div>
{:else}
	<div class="h-full flex flex-col bg-terminal-bg w-full">
		<!-- Status bar -->
		<div class="flex-shrink-0 bg-card border-b border-border px-4 py-2">
			<div class="flex items-center justify-between">
				<div class="flex items-center space-x-2">
					<div class="w-2 h-2 rounded-full {runtime.isConnected ? 'bg-status-success' : 'bg-status-error'}"></div>
					{#if chatId}
						<span class="text-xs text-primary">({chatDisplayNameShort})</span>
					{:else}
						<span class="text-xs text-muted-foreground">{m.shell_new_session()}</span>
					{/if}
					{#if !runtime.isInitialized}
						<span class="text-xs text-status-warning-foreground">{m.shell_initializing()}</span>
					{/if}
					{#if runtime.isRestarting}
						<span class="text-xs text-primary">{m.shell_restarting()}</span>
					{/if}
				</div>
				<div class="flex items-center space-x-3">
					<button
						onclick={() => void runtime.pasteFromClipboard()}
						class="text-xs text-muted-foreground hover:text-foreground flex items-center space-x-1"
						title={m.shell_paste_from_clipboard()}
					><span>{m.shell_paste()}</span></button>

					{#if runtime.isConnected}
						<button
							onclick={() => runtime.disconnectFromShell()}
							class="px-3 py-1 text-xs bg-destructive text-destructive-foreground rounded hover:bg-destructive/90 flex items-center space-x-1"
							title={m.shell_disconnect_shell()}
						>
							<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
							</svg>
							<span>{m.shell_disconnect()}</span>
						</button>
					{/if}

					<button
						onclick={restartShell}
						disabled={runtime.isRestarting || runtime.isConnected}
						class="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-1"
						title={m.shell_restart_shell()}
					>
						<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
						</svg>
						<span>{m.shell_restart()}</span>
					</button>
				</div>
			</div>
		</div>

		<!-- Terminal viewport -->
		<div class="flex-1 p-2 overflow-hidden relative">
			<div bind:this={terminalEl} class="h-full w-full outline-none focus-visible:ring-2 focus-visible:ring-ring" style="outline: none;"></div>

			{#if runtime.clipboardMessage}
				<div class="absolute top-2 right-2 z-20 rounded bg-destructive/90 px-3 py-2 text-xs text-destructive-foreground">
					{runtime.clipboardMessage}
				</div>
			{/if}

			{#if !runtime.isInitialized}
				<div class="absolute inset-0 flex items-center justify-center bg-background/90">
					<div class="text-foreground">{m.shell_loading_terminal()}</div>
				</div>
			{/if}

			{#if runtime.isConnecting}
				<div class="absolute inset-0 flex items-center justify-center bg-background/90 p-4">
					<div class="text-center max-w-sm w-full">
						<div class="flex items-center justify-center space-x-3 text-status-warning-foreground">
							<div class="w-6 h-6 animate-spin rounded-full border-2 border-status-warning border-t-transparent"></div>
							<span class="text-base font-medium">{m.shell_connecting()}</span>
						</div>
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}
