<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import type { GitQuickSummaryReady } from '$lib/api/git.js';
	import ComposerStatusBarFrame from './composer/ComposerStatusBarFrame.svelte';
	import type { LoadingStatus as ChatLoadingStatus } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
	import GitSummaryButton from '$lib/components/git/GitSummaryButton.svelte';
	import Square from '@lucide/svelte/icons/square';

	interface Props {
		isVisible: boolean;
		status: ChatLoadingStatus | null;
		agentId: string;
		onAbort: (() => void) | null;
		spinnerSelectionKey?: string | null;
		showCommit?: boolean;
		gitSummary?: GitQuickSummaryReady | null;
		gitRefreshing?: boolean;
		gitError?: string | null;
		onCommit?: (() => void) | null;
		announcementsEnabled?: boolean;
	}

	let {
		isVisible,
		status,
		agentId,
		onAbort,
		spinnerSelectionKey = null,
		showCommit = false,
		gitSummary = null,
		gitRefreshing = false,
		gitError = null,
		onCommit = null,
		announcementsEnabled = true,
	}: Props = $props();

	// Frame cadence for the character spinner. Lower feels snappier; the scale
	// pulse transition is tied to the same value so the two stay in step.
	const FRAME_INTERVAL_MS = 120;

	const SPINNER_SETS = [
		['\u25D0', '\u25D3', '\u25D1', '\u25D2'],
		[
			'\u280B',
			'\u2819',
			'\u2839',
			'\u2838',
			'\u283C',
			'\u2834',
			'\u2826',
			'\u2827',
			'\u2807',
			'\u280F',
		],
		['\u2736', '\u2737', '\u2738', '\u2739'],
	] as const;

	let animationPhase = $state(0);
	let activeSpinners = $state<string[]>([...SPINNER_SETS[0]]);

	let hasSpinnerSelection = false;
	let lastSpinnerSelectionKey: string | null = null;

	function pickRandomSpinnerSet(): string[] {
		return [...SPINNER_SETS[Math.floor(Math.random() * SPINNER_SETS.length)]];
	}

	$effect(() => {
		if (!isVisible) return;
		const timer = setInterval(() => {
			animationPhase = (animationPhase + 1) % activeSpinners.length;
		}, FRAME_INTERVAL_MS);
		return () => clearInterval(timer);
	});

	// Spinner set selection is randomized once per load and reset whenever
	// the selected chat changes while the indicator remains visible.
	$effect(() => {
		const nextSelectionKey = spinnerSelectionKey ?? null;
		if (!isVisible) {
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

	const statusText = $derived(
		agentId === 'codex' ? m.chat_loading_thinking() : status?.text || m.chat_loading_thinking(),
	);
	const canInterrupt = $derived(status?.can_interrupt !== false);
</script>

{#if isVisible}
	<ComposerStatusBarFrame tone="processing" {announcementsEnabled}>
		<div class="flex min-w-0 items-center gap-1.5">
			<span
				class="flex-shrink-0 text-sm text-status-processing transition-all {animationPhase % 2 === 0
					? 'scale-110'
					: ''}"
				style="transition-duration: {FRAME_INTERVAL_MS}ms"
			>
				{activeSpinners[animationPhase]}
			</span>
			<span class="truncate text-sm font-medium text-foreground">{statusText}...</span>
		</div>

		{#if showCommit || (canInterrupt && onAbort)}
			<div class="flex shrink-0 items-center gap-2">
				{#if showCommit && onCommit}
					<GitSummaryButton
						summary={gitSummary}
						isRefreshing={gitRefreshing}
						lastError={gitError}
						{onCommit}
					/>
				{/if}
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
		{/if}
	</ComposerStatusBarFrame>
{/if}
