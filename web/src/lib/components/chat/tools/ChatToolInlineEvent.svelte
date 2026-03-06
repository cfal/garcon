<script lang="ts">
	// Compact single-line tool display with action buttons.
	// Renders as a card surface instead of a rail/border-l treatment.

	import ChatEventCard from '../rows/ChatEventCard.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import type { ToolInlineAction } from '$lib/chat/tool-display-contract';

	interface OneLineDisplayProps {
		toolName: string;
		label?: string;
		value: string;
		secondary?: string;
		action?: ToolInlineAction;
		onAction?: () => void;
		style?: string;
		wrapText?: boolean;
		colorScheme?: {
			primary?: string;
			secondary?: string;
			background?: string;
			border?: string;
		};
		resultId?: string;
		toolResult?: Record<string, unknown>;
		toolId?: string;
	}

	const DEFAULT_SCHEME = {
		primary: 'text-foreground',
		secondary: 'text-muted-foreground',
		background: '',
		border: 'border-border'
	};

	let {
		toolName,
		label,
		value,
		secondary,
		action = 'none',
		onAction,
		style,
		wrapText = false,
		colorScheme = DEFAULT_SCHEME,
		resultId,
		toolResult,
		toolId
	}: OneLineDisplayProps = $props();

	let copied = $state(false);

	async function handleAction() {
		if (action === 'copyValue' && value) {
			const didCopy = await copyToClipboard(value);
			if (!didCopy) return;
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} else if (onAction) {
			onAction();
		}
	}

	let isTerminal = $derived(style === 'terminal');
	let displayName = $derived(value.split('/').pop() || value);
	let grepPatternValue = $derived.by(() => {
		if (toolName !== 'Grep' || !secondary) return '';
		const trimmed = secondary.trim();
		if (!trimmed) return '';
		return trimmed.replace(/^Pattern:\s*/i, '');
	});
	let showGrepPatternRow = $derived(toolName === 'Grep' && grepPatternValue.length > 0);
</script>

{#snippet copyIcon()}
	{#if copied}
		<svg
			class="w-3 h-3 text-status-success-foreground"
			fill="none"
			stroke="currentColor"
			viewBox="0 0 24 24"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width="2"
				d="M5 13l4 4L19 7"
			/>
		</svg>
	{:else}
		<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width="2"
				d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
			/>
		</svg>
	{/if}
{/snippet}

{#snippet copyButton()}
	<button
		onclick={handleAction}
		class="opacity-100 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100 text-muted-foreground hover:text-foreground flex-shrink-0"
		title={m.chat_tool_display_copy_to_clipboard()}
		aria-label={m.chat_tool_display_copy_to_clipboard()}
	>
		{@render copyIcon()}
	</button>
{/snippet}

<div class="group my-0.5">
	{#if isTerminal}
		<ChatEventCard variant="default" compact>
			{#snippet body()}
				<div class="mb-0.5 flex items-center gap-1.5 min-w-0">
					<span class="text-[11px] font-medium text-muted-foreground tracking-wide">{label || toolName}</span>
					{#if action === 'copyValue'}
						{@render copyButton()}
					{/if}
				</div>
				<code
					class="text-xs text-foreground font-mono {wrapText
						? 'whitespace-pre-wrap break-all'
						: 'block truncate'}"
				>
					{value}
				</code>
					{#if secondary}
						<div class="mt-0.5">
							<span class="text-[11px] text-muted-foreground italic">
								{secondary}
							</span>
						</div>
					{/if}
			{/snippet}
		</ChatEventCard>
	{:else if action === 'openFile'}
		<ChatEventCard variant="default" compact>
			{#snippet body()}
					<div class="min-w-0">
						<div class="flex items-center gap-1.5 min-w-0">
							<span class="text-xs text-muted-foreground flex-shrink-0">{label || toolName}</span>
							<button
								onclick={handleAction}
								class="text-xs text-primary hover:text-primary/80 font-mono hover:underline transition-colors truncate"
								title={value}
						>
							{displayName}
						</button>
					</div>
						{#if secondary}
							<div class="mt-0.5 text-[11px] text-muted-foreground break-words">{secondary}</div>
						{/if}
					</div>
				{/snippet}
			</ChatEventCard>
	{:else if action === 'jumpToResult'}
		<ChatEventCard variant="default" compact>
			{#snippet body()}
				<div class="min-w-0">
					<div class="flex items-start gap-2 min-w-0">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-1.5 min-w-0">
								<span class="text-xs text-muted-foreground flex-shrink-0">{label || toolName}</span>
								<span class="text-xs font-medium truncate min-w-0 {colorScheme.primary}">
									{value}
								</span>
							</div>
						</div>
						{#if toolResult}
							<a
								href="#tool-result-{toolId}"
								class="flex-shrink-0 text-[11px] text-primary hover:text-primary/80 transition-colors flex items-center gap-0.5 mt-0.5"
								aria-label={m.chat_tool_display_jump_to_results()}
							>
								<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M19 9l-7 7-7-7"
									/>
								</svg>
							</a>
						{/if}
					</div>
						{#if secondary}
							<div class="mt-0.5 text-[11px] text-muted-foreground break-words">{secondary}</div>
						{/if}
					</div>
				{/snippet}
			</ChatEventCard>
	{:else}
		<ChatEventCard variant="default" compact>
				{#snippet body()}
					<div class="min-w-0">
						<div class="flex items-center gap-1.5 min-w-0">
							{#if label || toolName}
								<span class="text-xs text-muted-foreground flex-shrink-0">{label || toolName}</span>
							{/if}
							<span
								class="text-xs font-mono {wrapText
								? 'whitespace-pre-wrap break-all'
								: 'truncate'} flex-1 min-w-0 {colorScheme.primary}"
							>
								{value}
							</span>
							{#if action === 'copyValue'}
								{@render copyButton()}
							{/if}
						</div>
							{#if showGrepPatternRow}
								<div class="mt-0.5 flex items-center gap-1.5 min-w-0">
									<span class="text-xs text-muted-foreground flex-shrink-0">Pattern</span>
									<span
										class="text-xs font-mono {wrapText
									? 'whitespace-pre-wrap break-all'
									: 'truncate'} flex-1 min-w-0 {colorScheme.primary}"
								>
									{grepPatternValue}
								</span>
							</div>
						{:else if secondary}
							<span class="text-[11px] {colorScheme.secondary} italic flex-shrink-0">
								{secondary}
							</span>
						{/if}
					</div>
			{/snippet}
		</ChatEventCard>
	{/if}
</div>
