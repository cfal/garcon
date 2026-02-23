<script lang="ts">
	// Thinking status overlay at the bottom of the messages pane.
	// Shows animated spinner, status text, elapsed time, and a stop
	// button when the agent can be interrupted.

	import { onDestroy } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		isLoading: boolean;
		status: { text?: string; can_interrupt?: boolean } | null;
		provider: string;
		isScrolledToBottom: boolean;
		onAbort: (() => void) | null;
		spinnerSelectionKey?: string | null;
	}

	let {
		isLoading,
		status,
		provider,
		isScrolledToBottom,
		onAbort,
		spinnerSelectionKey = null
	}: Props = $props();

	const SPINNER_SETS = [
		['\u25D0', '\u25D3', '\u25D1', '\u25D2'],
		['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'],
		['\u2736', '\u2737', '\u2738', '\u2739']
	] as const;
	const BG_DEBOUNCE_MS = 250;

	let animationPhase = $state(0);
	let activeSpinners = $state<string[]>([...SPINNER_SETS[0]]);
	let showBg = $state(false);

	let animTimer: ReturnType<typeof setInterval> | null = null;
	let bgTimer: ReturnType<typeof setTimeout> | null = null;
	let hasSpinnerSelection = false;
	let lastSpinnerSelectionKey: string | null = null;

	function pickRandomSpinnerSet(): string[] {
		return [...SPINNER_SETS[Math.floor(Math.random() * SPINNER_SETS.length)]];
	}

	// Spinner animation.
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

	// Debounced background when scrolled up.
	$effect(() => {
		if (bgTimer) { clearTimeout(bgTimer); bgTimer = null; }
		if (isScrolledToBottom) {
			showBg = false;
		} else {
			bgTimer = setTimeout(() => { showBg = true; }, BG_DEBOUNCE_MS);
		}
		return () => { if (bgTimer) clearTimeout(bgTimer); };
	});

	onDestroy(() => {
		if (animTimer) clearInterval(animTimer);
		if (bgTimer) clearTimeout(bgTimer);
	});

	const statusText = $derived(provider === 'codex' ? m.chat_loading_thinking() : (status?.text || m.chat_loading_thinking()));
	const canInterrupt = $derived(status?.can_interrupt !== false);
</script>

{#if isLoading}
	<div
		class="absolute bottom-0 left-0 right-0 z-10 border-t {showBg
			? 'bg-card border-border'
			: 'border-transparent'}"
	>
		<div class="flex items-center justify-between px-3 sm:px-4 py-2 leading-none">
				<div class="flex items-center gap-1.5 min-w-0">
					<span
						class="text-xs sm:text-sm transition-all duration-500 flex-shrink-0 text-status-processing {animationPhase % 2 === 0 ? 'scale-110' : ''}"
					>
						{activeSpinners[animationPhase]}
					</span>
				<span class="font-medium text-xs sm:text-sm truncate">{statusText}...</span>
			</div>

				{#if canInterrupt && onAbort}
					<button
						onclick={onAbort}
						class="ml-2 mr-1 text-xs sm:text-sm border border-stop-button-border bg-stop-button-bg text-stop-button-foreground hover:bg-stop-button-bg/90 px-2.5 py-1 sm:px-3 sm:py-1 rounded-md transition-colors flex items-center flex-shrink-0 font-medium"
					>
					<span class="hidden sm:inline">{m.chat_loading_stop()}</span>
				</button>
			{/if}
		</div>
	</div>
{/if}
