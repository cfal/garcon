<script lang="ts">
	import { onDestroy, tick, untrack, type Snippet } from 'svelte';
	import Braces from '@lucide/svelte/icons/braces';
	import FileText from '@lucide/svelte/icons/file-text';
	import ComposerSnippetPalette from '$lib/components/chat/composer/ComposerSnippetPalette.svelte';
	import { ScheduledPromptSnippets } from './scheduled-prompt-snippets.svelte';
	import type { ScheduledSnippetExpansionContext } from '$shared/snippets';
	import { Button } from '$lib/components/ui/button';
	import { SCHEDULED_PROMPT_CHAT_ID_TOKEN } from '$shared/scheduled-prompts';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		ref?: HTMLTextAreaElement | null;
		prompt: string;
		promptError: string | null;
		targetType: 'new-chat' | 'existing-chat';
		surface: 'composer' | 'standalone';
		onPromptChange: (value: string) => void;
		onPromptKeydown: (event: KeyboardEvent) => void;
		controls?: Snippet;
		snippetContext?: ScheduledSnippetExpansionContext | null;
		snippetContextKey?: string;
		snippetTrigger?: string;
		onEditSnippets?: (returnFocus: () => void) => void;
		onSnippetPendingChange?: (pending: boolean) => void;
	}

	let {
		ref = $bindable(null),
		prompt,
		promptError,
		targetType,
		surface,
		onPromptChange,
		onPromptKeydown,
		controls,
		snippetContext,
		snippetContextKey = '',
		snippetTrigger = ';;',
		onEditSnippets,
		onSnippetPendingChange,
	}: Props = $props();
	const id = $props.id();
	const inputId = `${id}-input`;
	const descriptionId = `${id}-description`;
	const variableHelpId = `${id}-variable-help`;
	const snippetHelpId = `${id}-snippet-help`;
	const errorId = `${id}-error`;
	let resizeFrame: number | null = null;
	const interactionKey = $derived(`${JSON.stringify(snippetContext)}\u0000${snippetContextKey}`);
	const snippets = new ScheduledPromptSnippets({
		get prompt() {
			return prompt;
		},
		get context() {
			return snippetContext ?? null;
		},
		get interactionKey() {
			return interactionKey;
		},
		onInsert: async (text, caret) => {
			onPromptChange(text);
			await tick();
			if (!ref) return;
			ref.focus({ preventScroll: true });
			ref.setSelectionRange(caret, caret);
			resizeTextarea();
		},
		onPendingChange: (pending) => onSnippetPendingChange?.(pending),
	});
	$effect(() => {
		interactionKey;
		untrack(() => snippets.cancel());
	});
	onDestroy(() => snippets.cancel());
	function returnFocus(): void {
		ref?.focus({ preventScroll: true });
	}
	const visibleError = $derived(prompt.length > 0 ? promptError : null);
	const describedBy = $derived(
		[
			descriptionId,
			variableHelpId,
			snippetContext !== undefined ? snippetHelpId : null,
			visibleError ? errorId : null,
		]
			.filter(Boolean)
			.join(' '),
	);

	function resizeTextarea(): void {
		if (!ref || surface !== 'composer') return;
		ref.style.height = 'auto';
		ref.style.height = `${ref.scrollHeight}px`;
	}

	$effect(() => {
		prompt;
		ref;
		if (surface !== 'composer' || !ref) return;
		if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
		resizeFrame = requestAnimationFrame(() => {
			resizeFrame = null;
			resizeTextarea();
		});
		return () => {
			if (resizeFrame === null) return;
			cancelAnimationFrame(resizeFrame);
			resizeFrame = null;
		};
	});

	function handleInput(event: Event): void {
		const textarea = event.currentTarget;
		if (!(textarea instanceof HTMLTextAreaElement)) return;
		onPromptChange(textarea.value);
		resizeTextarea();
		if (snippetContext !== undefined) {
			snippets.detectTrigger(textarea.selectionStart, snippetTrigger, textarea.value);
		}
	}

	async function insertChatId(): Promise<void> {
		if (!ref) return;
		const start = ref.selectionStart;
		const end = ref.selectionEnd;
		const nextPrompt = `${ref.value.slice(0, start)}${SCHEDULED_PROMPT_CHAT_ID_TOKEN}${ref.value.slice(end)}`;
		const nextCaret = start + SCHEDULED_PROMPT_CHAT_ID_TOKEN.length;
		ref.value = nextPrompt;
		onPromptChange(nextPrompt);
		await tick();
		ref.focus();
		ref.setSelectionRange(nextCaret, nextCaret);
		resizeTextarea();
	}
</script>

<div class="space-y-2" data-slot="scheduled-prompt-field" data-surface={surface}>
	<div>
		<label for={inputId} class="text-sm font-medium">{m.scheduled_prompts_prompt()}</label>
		<p id={descriptionId} class="text-xs text-muted-foreground">
			{m.scheduled_prompts_prompt_description()}
		</p>
	</div>

	<div
		class={surface === 'composer'
			? 'relative min-h-[120px] rounded-lg border border-border'
			: undefined}
		data-slot={surface === 'composer' ? 'scheduled-new-chat-composer' : undefined}
	>
		<textarea
			bind:this={ref}
			id={inputId}
			value={prompt}
			readonly={snippets.expansion.pending}
			oninput={handleInput}
			onkeydown={onPromptKeydown}
			rows={surface === 'composer' ? 2 : 5}
			aria-describedby={describedBy}
			aria-invalid={visibleError ? 'true' : undefined}
			placeholder={m.scheduled_prompts_prompt_placeholder()}
			class={surface === 'composer'
				? 'chat-input-placeholder block min-h-11 max-h-[40vh] w-full resize-none overflow-y-auto bg-transparent px-4 py-1.5 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground sm:max-h-[500px] sm:py-3 sm:pointer-fine:text-sm'
				: 'block min-h-32 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-base leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm'}
		></textarea>

		{#if controls}
			{@render controls()}
		{/if}
	</div>

	<div class="flex flex-wrap items-center gap-2">
		{#if snippetContext !== undefined}
			<Button
				variant="secondary"
				size="sm"
				class="h-9 text-xs"
				disabled={snippets.expansion.pending}
				onclick={() =>
					snippets.open(ref?.selectionStart ?? prompt.length, ref?.selectionEnd ?? prompt.length)}
			>
				<FileText class="size-4" />{m.snippets_picker_title()}
			</Button>
		{/if}
		<Button
			variant="ghost"
			size="sm"
			class="h-9 px-2 text-xs"
			disabled={snippets.expansion.pending}
			onclick={() => void insertChatId()}
		>
			<Braces class="size-4" />{m.scheduled_prompts_insert_chat_id({
				token: SCHEDULED_PROMPT_CHAT_ID_TOKEN,
			})}
		</Button>
	</div>
	<div>
		<p id={variableHelpId} class="text-xs text-muted-foreground">
			{targetType === 'new-chat'
				? m.scheduled_prompts_new_chat_id_help({ token: SCHEDULED_PROMPT_CHAT_ID_TOKEN })
				: m.scheduled_prompts_existing_chat_id_help({ token: SCHEDULED_PROMPT_CHAT_ID_TOKEN })}
		</p>
	</div>

	<div class="min-h-5">
		{#if snippetContext !== undefined}
			<p id={snippetHelpId} class="text-xs leading-relaxed text-muted-foreground">
				{m.scheduled_prompts_snippet_help({ token: SCHEDULED_PROMPT_CHAT_ID_TOKEN })}
			</p>
		{/if}
		{#if snippets.expansion.pending}
			<p role="status" class="text-xs text-muted-foreground">{m.snippets_expanding()}</p>
		{:else if snippets.error}
			<p role="alert" class="text-xs text-destructive">{snippets.error}</p>
		{/if}
		{#if visibleError}
			<p id={errorId} class="text-xs text-destructive">{visibleError}</p>
		{/if}
	</div>
</div>

{#if snippetContext !== undefined}
	<ComposerSnippetPalette
		open={snippets.palette.isOpen}
		onOpenChange={(open) => (open ? snippets.palette.openFromMenu() : snippets.palette.hide())}
		initialQuery={snippets.palette.initialQuery}
		{interactionKey}
		contextHint={snippetContext ? null : m.snippets_palette_context_hint()}
		onInsert={(snippet, argumentsText) => snippets.insert(snippet, argumentsText)}
		onCancelled={() => snippets.palette.dismiss()}
		onReturnFocus={returnFocus}
		onEditSnippets={() => onEditSnippets?.(returnFocus)}
	/>
{/if}
