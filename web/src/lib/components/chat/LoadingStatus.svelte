<script lang="ts">
	// Renders the composer-anchored status tray shown while an agent is running.

	import { onDestroy } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import { Square } from '@lucide/svelte';

	interface Props {
		isLoading: boolean;
		status: { text?: string; can_interrupt?: boolean } | null;
		provider: string;
		onAbort: (() => void) | null;
		spinnerSelectionKey?: string | null;
	}

	let {
		isLoading,
		status,
		provider,
		onAbort,
		spinnerSelectionKey = null
	}: Props = $props();

	const SPINNER_SETS = [
		['\u25D0', '\u25D3', '\u25D1', '\u25D2'],
		['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'],
		['\u2736', '\u2737', '\u2738', '\u2739']
	] as const;

	let animationPhase = $state(0);
	let activeSpinners = $state<string[]>([...SPINNER_SETS[0]]);

	let animTimer: ReturnType<typeof setInterval> | null = null;
	let hasSpinnerSelection = false;
	let lastSpinnerSelectionKey: string | null = null;

	function pickRandomSpinnerSet(): string[] {
		return [...SPINNER_SETS[Math.floor(Math.random() * SPINNER_SETS.length)]];
	}

	// Animates the spinner while the tray is visible.
	$effect(() => {
		if (animTimer) { clearInterval(animTimer); animTimer = null; }
		if (!isLoading) return;
		animTimer = setInterval(() => { animationPhase = (animationPhase + 1) % activeSpinners.length; }, 500);
		return () => { if (animTimer) clearInterval(animTimer); };
	});

	// Spinner set selection is randomized once per load and reset whenever
	// the selected chat changes while the indicator remains visible.
	$effect(() => {
		const nextSelectionKey = spinnerSelectionKey ?? null;
		if (!isLoading) {
			hasSpinnerSelection = false;
			lastSpinnerSelectionKey = null;
			animationPhase = 0;
			return;
		}
		if (!hasSpinnerSelection || lastSpinnerSelectionKey !== nextSelectionKey) {
			activeSpinners = pickRandomSpinnerSet();
			animationPhase = 0;
			hasSpinnerSelection = true;
			lastSpinnerSelectionKey = nextSelectionKey;
		}
	});

	onDestroy(() => {
		if (animTimer) clearInterval(animTimer);
	});

	const statusText = $derived(provider === 'codex' ? m.chat_loading_thinking() : (status?.text || m.chat_loading_thinking()));
	const canInterrupt = $derived(status?.can_interrupt !== false);
	const statusTrayClass = cn(
		'absolute bottom-full left-2 right-2 z-10 sm:left-3 sm:right-3'
	);
	const statusPanelClass = cn(
		'pointer-events-auto flex min-h-10 items-center justify-between gap-3 rounded-t-2xl bg-chat-thinking px-3 py-2 shadow-sm sm:px-4'
	);
</script>

{#if isLoading}
	<div class={statusTrayClass}>
		<div class={statusPanelClass} role="status" aria-live="polite">
			<div class="flex min-w-0 items-center gap-1.5">
				<span
					class="flex-shrink-0 text-xs text-status-processing transition-all duration-500 sm:text-sm {animationPhase % 2 === 0 ? 'scale-110' : ''}"
				>
					{activeSpinners[animationPhase]}
				</span>
				<span class="truncate text-xs font-medium text-foreground sm:text-sm">{statusText}...</span>
			</div>

			{#if canInterrupt && onAbort}
				<button
					type="button"
					onclick={onAbort}
					aria-label={m.chat_loading_stop()}
					title={m.chat_loading_stop()}
					class="inline-flex h-7 flex-shrink-0 items-center gap-1.5 rounded-md border border-border bg-background/70 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<Square class="size-3" aria-hidden="true" />
					<span class="hidden sm:inline">{m.chat_loading_stop()}</span>
				</button>
			{/if}
		</div>
	</div>
{/if}
