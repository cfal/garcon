<script lang="ts">
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Save from '@lucide/svelte/icons/save';
	import { untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as m from '$lib/paraglide/messages.js';
	import {
		COMMIT_MESSAGE_DIFF_TOKEN,
		COMMIT_MESSAGE_FILES_TOKEN,
		GENERATION_PROMPT_TEMPLATE_MAX_LENGTH,
		PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
	} from '$shared/generation-prompts';
	import type { GenerationPromptSaveResult } from './remote-generation-settings-card-state.svelte';

	export type GenerationPromptKind = 'commit-message' | 'prompt-refinement';

	interface Props {
		kind: GenerationPromptKind;
		initialPrompt: string;
		defaultPrompt: string;
		onSave: (customPrompt: string) => Promise<GenerationPromptSaveResult>;
		onCancel: () => void;
	}

	let { kind, initialPrompt, defaultPrompt, onSave, onCancel }: Props = $props();
	let draft = $state(
		untrack(() => (initialPrompt.trim() ? initialPrompt : defaultPrompt)),
	);
	let saveError = $state<string | null>(null);
	let isSaving = $state(false);
	let textareaRef = $state<HTMLTextAreaElement | null>(null);

	let validationError = $derived.by(() => {
		if (draft.length > GENERATION_PROMPT_TEMPLATE_MAX_LENGTH) {
			return m.settings_generation_prompt_too_long({
				limit: GENERATION_PROMPT_TEMPLATE_MAX_LENGTH,
			});
		}
		if (
			kind === 'prompt-refinement'
			&& draft.trim()
			&& !draft.includes(PROMPT_REFINEMENT_USER_PROMPT_TOKEN)
		) {
			return m.settings_generation_prompt_required_token({
				token: PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
			});
		}
		return null;
	});

	let title = $derived(
		kind === 'commit-message'
			? m.settings_commit_prompt_dialog_title()
			: m.settings_prompt_refinement_prompt_dialog_title(),
	);
	let description = $derived(
		kind === 'commit-message'
			? m.settings_commit_prompt_dialog_description()
			: m.settings_prompt_refinement_prompt_dialog_description(),
	);

	function handleCloseRequest(): void {
		if (!isSaving) onCancel();
	}

	async function handleSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		saveError = null;
		if (validationError) return;

		isSaving = true;
		const customPrompt = !draft.trim() || draft === defaultPrompt ? '' : draft;
		const result = await onSave(customPrompt);
		isSaving = false;
		if (result.ok) return;
		saveError = result.message;
	}
</script>

<Dialog.Root open requestClose={handleCloseRequest}>
	<Dialog.Content
		class="flex h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] max-w-[calc(100%_-_1rem)] flex-col gap-0 overflow-hidden p-0 sm:h-[min(80dvh,48rem)] sm:max-w-4xl"
		showCloseButton={false}
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			textareaRef?.focus();
		}}
	>
		<form class="flex min-h-0 flex-1 flex-col" onsubmit={handleSubmit}>
			<Dialog.Header class="shrink-0 border-b border-border px-5 py-4 pr-12 text-start sm:px-6">
				<Dialog.Title>{title}</Dialog.Title>
				<Dialog.Description>{description}</Dialog.Description>
			</Dialog.Header>

			<div class="flex min-h-0 flex-1 flex-col gap-2 px-4 py-4 sm:px-6">
				<label class="sr-only" for="generation-prompt-draft">{title}</label>
				<textarea
					id="generation-prompt-draft"
					bind:this={textareaRef}
					bind:value={draft}
					disabled={isSaving}
					aria-invalid={validationError || saveError ? 'true' : undefined}
					aria-describedby="generation-prompt-feedback"
					spellcheck="true"
					class="min-h-0 flex-1 resize-none rounded-md border border-input bg-background p-3 font-mono text-base leading-6 text-foreground outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
				></textarea>
				<div
					id="generation-prompt-feedback"
					class="min-h-5 text-sm"
					aria-live="polite"
				>
					{#if validationError}
						<span class="text-destructive">{validationError}</span>
					{:else if saveError}
						<span class="text-destructive">{saveError}</span>
					{/if}
				</div>
			</div>

			<div class="shrink-0 border-t border-border bg-muted/40 px-5 py-3 sm:px-6">
				<div class="text-xs font-medium text-foreground">
					{m.settings_generation_prompt_legend_title()}
				</div>
				<div class="mt-1 flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:gap-5">
					{#if kind === 'commit-message'}
						<div>
							<code class="font-mono text-foreground">{COMMIT_MESSAGE_FILES_TOKEN}</code>
							{m.settings_commit_prompt_legend_files()}
						</div>
						<div>
							<code class="font-mono text-foreground">{COMMIT_MESSAGE_DIFF_TOKEN}</code>
							{m.settings_commit_prompt_legend_diff()}
						</div>
					{:else}
						<div>
							<code class="font-mono text-foreground">{PROMPT_REFINEMENT_USER_PROMPT_TOKEN}</code>
							{m.settings_prompt_refinement_prompt_legend_user_prompt()}
						</div>
					{/if}
				</div>
			</div>

			<Dialog.Footer class="shrink-0 flex-col border-t border-border px-5 py-4 sm:flex-row sm:justify-between sm:px-6">
				<Button
					type="button"
					variant="outline"
					disabled={isSaving || draft === defaultPrompt}
					onclick={() => {
						draft = defaultPrompt;
						saveError = null;
					}}
				>
					<RotateCcw />
					{m.settings_generation_prompt_restore_default()}
				</Button>
				<div class="flex justify-end gap-2">
					<Button type="button" variant="outline" disabled={isSaving} onclick={onCancel}>
						{m.sidebar_actions_cancel()}
					</Button>
					<Button type="submit" disabled={isSaving || Boolean(validationError)}>
						<Save />
						{isSaving
							? m.settings_generation_prompt_saving()
							: m.sidebar_actions_save()}
					</Button>
				</div>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
