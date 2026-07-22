<script lang="ts">
	// Renders the composer-anchored status tray shown while an agent is running.

	import { onDestroy } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import type { GitQuickSummaryReady } from '$lib/api/git.js';
	import type { LoadingStatus as ChatLoadingStatus } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import Square from '@lucide/svelte/icons/square';

	interface Props {
		isVisible: boolean;
		status: ChatLoadingStatus | null;
		agentId: string;
		onAbort: (() => void) | null;
		spinnerSelectionKey?: string | null;
		quickCommitVisible?: boolean;
		quickCommitSummary?: GitQuickSummaryReady | null;
		onQuickCommit?: (() => void) | null;
	}

	let {
		isVisible,
		status,
		agentId,
		onAbort,
		spinnerSelectionKey = null,
		quickCommitVisible = false,
		quickCommitSummary = null,
		onQuickCommit = null,
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

	let animTimer: ReturnType<typeof setInterval> | null = null;
	let hasSpinnerSelection = false;
	let lastSpinnerSelectionKey: string | null = null;

	function pickRandomSpinnerSet(): string[] {
		return [...SPINNER_SETS[Math.floor(Math.random() * SPINNER_SETS.length)]];
	}

	// Animates the spinner while the tray is visible.
	$effect(() => {
		if (animTimer) {
			clearInterval(animTimer);
			animTimer = null;
		}
		if (!isVisible) return;
		animTimer = setInterval(() => {
			animationPhase = (animationPhase + 1) % activeSpinners.length;
		}, FRAME_INTERVAL_MS);
		return () => {
			if (animTimer) clearInterval(animTimer);
		};
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

	onDestroy(() => {
		if (animTimer) clearInterval(animTimer);
	});

	const statusText = $derived(
		agentId === 'codex' ? m.chat_loading_thinking() : status?.text || m.chat_loading_thinking(),
	);
	const canInterrupt = $derived(status?.can_interrupt !== false);
	const quickCommitHasDiffStats = $derived(
		Boolean(
			quickCommitSummary && (quickCommitSummary.additions > 0 || quickCommitSummary.deletions > 0),
		),
	);
	// The cap stays out of flow while sliding underneath the rounded composer
	// edge; feed/queue reservation still owns the vertical space above.
	const statusTrayClass = cn('absolute bottom-full left-0 right-0 z-10 translate-y-3');
	// Extra bottom padding gives the composer something solid to overlap, hiding
	// the tray's lower edge behind the composer's stable rounded corners.
	// `relative` anchors the thinking-shimmer ring pseudo-element to the panel.
	const statusPanelClass = cn(
		'pointer-events-auto relative flex min-h-14 items-center justify-between gap-3 rounded-t-2xl border border-b-0 border-border bg-chat-thinking px-3 pb-5 pt-2 sm:px-4',
	);
</script>

{#if isVisible}
	<div class={statusTrayClass}>
		<div
			class={statusPanelClass}
			role="status"
			aria-live="polite"
			data-slot="chat-processing-status"
		>
			<div class="flex min-w-0 items-center gap-1.5">
				<span
					class="flex-shrink-0 text-sm text-status-processing transition-all {animationPhase % 2 ===
					0
						? 'scale-110'
						: ''}"
					style="transition-duration: {FRAME_INTERVAL_MS}ms"
				>
					{activeSpinners[animationPhase]}
				</span>
				<span class="truncate text-sm font-medium text-foreground">{statusText}...</span>
			</div>

			{#if quickCommitVisible || (canInterrupt && onAbort)}
				<div class="flex shrink-0 items-center gap-2">
					{#if quickCommitVisible && onQuickCommit}
						<button
							type="button"
							onclick={onQuickCommit}
							aria-label={m.git_changes_commit()}
							title={m.git_changes_commit()}
							class="inline-flex h-7 flex-shrink-0 items-center gap-1.5 rounded-md border border-border bg-background/70 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{#if quickCommitHasDiffStats && quickCommitSummary}
								<span class="inline-flex items-center gap-1 tabular-nums">
									{#if quickCommitSummary.additions > 0}
										<span class="text-git-added">
											{m.git_quick_status_additions({ count: quickCommitSummary.additions })}
										</span>
									{/if}
									{#if quickCommitSummary.additions > 0 && quickCommitSummary.deletions > 0}
										<span class="text-muted-foreground">/</span>
									{/if}
									{#if quickCommitSummary.deletions > 0}
										<span class="text-git-deleted">
											{m.git_quick_status_deletions({ count: quickCommitSummary.deletions })}
										</span>
									{/if}
								</span>
							{:else}
								<GitCommitHorizontal class="h-3.5 w-3.5" aria-hidden="true" />
								<span class="hidden sm:inline">{m.git_changes_commit()}</span>
							{/if}
						</button>
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
		</div>
	</div>
{/if}
