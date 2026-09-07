<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import Braces from '@lucide/svelte/icons/braces';
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
	}: Props = $props();
	const id = $props.id();
	const inputId = `${id}-input`;
	const descriptionId = `${id}-description`;
	const variableHelpId = `${id}-variable-help`;
	const errorId = `${id}-error`;
	let resizeFrame: number | null = null;
	const visibleError = $derived(prompt.length > 0 ? promptError : null);
	const describedBy = $derived(
		[descriptionId, variableHelpId, visibleError ? errorId : null].filter(Boolean).join(' '),
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
		onPromptChange(
			event.currentTarget instanceof HTMLTextAreaElement ? event.currentTarget.value : '',
		);
		resizeTextarea();
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

	<div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
		<p id={variableHelpId} class="text-xs text-muted-foreground">
			{targetType === 'new-chat'
				? m.scheduled_prompts_new_chat_id_help({ token: SCHEDULED_PROMPT_CHAT_ID_TOKEN })
				: m.scheduled_prompts_existing_chat_id_help({ token: SCHEDULED_PROMPT_CHAT_ID_TOKEN })}
		</p>
		<Button
			variant="ghost"
			size="sm"
			class="h-8 shrink-0 self-start px-2 text-xs sm:self-auto"
			onclick={() => void insertChatId()}
		>
			<Braces class="size-4" />
			{m.scheduled_prompts_insert_chat_id({ token: SCHEDULED_PROMPT_CHAT_ID_TOKEN })}
		</Button>
	</div>

	<div class="min-h-5">
		{#if visibleError}
			<p id={errorId} class="text-xs text-destructive">{visibleError}</p>
		{/if}
	</div>
</div>
