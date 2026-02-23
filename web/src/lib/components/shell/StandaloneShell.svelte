<script lang="ts">
	// Thin wrapper around Shell for use as the standalone Shell tab.
	// Manages lifecycle and provides a restart button in an optional header.

	import Shell from './Shell.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface StandaloneShellProps {
		initialPath?: string | null;
		chatId?: string | null;
		command?: string | null;
		onComplete?: ((exitCode: number) => void) | null;
		onClose?: (() => void) | null;
		title?: string | null;
		class?: string;
		showHeader?: boolean;
		compact?: boolean;
		minimal?: boolean;
	}

	let {
		initialPath = null,
		chatId = null,
		command = null,
		onComplete = null,
		onClose = null,
		title = null,
		class: className = '',
		showHeader = true,
		compact = false,
		minimal = false
	}: StandaloneShellProps = $props();

	let isCompleted = $state(false);

	function handleProcessComplete(exitCode: number) {
		isCompleted = true;
		onComplete?.(exitCode);
	}
</script>

{#if !initialPath && !minimal}
	<div class="h-full flex items-center justify-center {className}">
		<div class="text-center text-muted-foreground">
			<div class="w-16 h-16 mx-auto mb-4 bg-muted rounded-full flex items-center justify-center">
				<svg class="w-8 h-8 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" />
				</svg>
			</div>
			<h3 class="text-lg font-semibold mb-2">{m.shell_standalone_no_directory()}</h3>
			<p>{m.shell_standalone_select_chat()}</p>
		</div>
	</div>
{:else}
	<div class="h-full w-full flex flex-col {className}">
		{#if !minimal && showHeader && title}
			<div class="flex-shrink-0 bg-card border-b border-border px-4 py-2">
				<div class="flex items-center justify-between">
					<div class="flex items-center space-x-2">
						<h3 class="text-sm font-medium text-foreground">{title}</h3>
						{#if isCompleted}
							<span class="text-xs text-status-success-foreground">{m.shell_standalone_completed()}</span>
						{/if}
					</div>
					{#if onClose}
						<button
							onclick={onClose}
							class="text-muted-foreground hover:text-foreground"
							title={m.shell_standalone_close()}
						>
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					{/if}
				</div>
			</div>
		{/if}

		<div class="flex-1 w-full min-h-0">
			<Shell
				projectPath={initialPath}
				{chatId}
				initialCommand={command ?? undefined}
				onProcessComplete={handleProcessComplete}
				{minimal}
			/>
		</div>
	</div>
{/if}
