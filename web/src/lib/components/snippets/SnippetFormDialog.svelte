<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { ApiError } from '$lib/api/client.js';
	import { getSnippets } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import type { Snippet, SnippetDefinitionInput } from '$shared/snippets';
	import { SnippetFormState } from './snippet-form-state.svelte.js';

	interface Props {
		open: boolean;
		snippet: Snippet | null;
		onSave: (definition: SnippetDefinitionInput) => Promise<void>;
		onClose: () => void;
	}

	let { open, snippet, onSave, onClose }: Props = $props();
	const snippets = getSnippets();
	let form = $state(new SnippetFormState(() => snippets.snippets));

	$effect(() => {
		if (!open) return;
		const nextForm = new SnippetFormState(() => snippets.snippets);
		nextForm.reset(snippet);
		form = nextForm;
	});

	function errorDetail(error: unknown): string {
		if (error instanceof ApiError) return error.details || error.message;
		return error instanceof Error ? error.message : String(error);
	}

	async function save(): Promise<void> {
		const definition = form.buildDefinition();
		if (!definition || form.saving) return;
		form.saving = true;
		form.error = null;
		try {
			await onSave(definition);
			onClose();
		} catch (error) {
			form.error = m.snippets_save_error({ detail: errorDetail(error) });
		} finally {
			form.saving = false;
		}
	}

	function handleTemplateKeyDown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
		event.preventDefault();
		void save();
	}
</script>

<Dialog.Root {open} requestClose={() => !form.saving && onClose()}>
	<Dialog.Content
		class="flex max-h-[min(42rem,calc(var(--app-height)-1rem))] flex-col sm:max-w-2xl"
	>
		<Dialog.Header>
			<Dialog.Title>
				{snippet ? m.snippets_form_edit_title() : m.snippets_form_add_title()}
			</Dialog.Title>
			<Dialog.Description>{m.snippets_form_description()}</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 space-y-5 overflow-y-auto px-0.5 py-1">
			<div class="space-y-1.5">
				<label for="snippet-short-name" class="text-sm font-medium text-foreground">
					{m.snippets_short_name_label()}
				</label>
				<input
					id="snippet-short-name"
					bind:value={form.shortName}
					type="text"
					autocomplete="off"
					spellcheck="false"
					placeholder={m.snippets_short_name_placeholder()}
					aria-invalid={Boolean(form.shortNameError)}
					aria-describedby="snippet-short-name-help snippet-short-name-error"
					class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
				/>
				<p id="snippet-short-name-help" class="text-xs text-muted-foreground">
					{m.snippets_short_name_help()}
				</p>
				<p id="snippet-short-name-error" class="min-h-4 text-xs text-destructive">
					{form.shortNameError ?? ''}
				</p>
			</div>

			<div class="space-y-1.5">
				<label for="snippet-template" class="text-sm font-medium text-foreground">
					{m.snippets_template_label()}
				</label>
				<textarea
					id="snippet-template"
					bind:value={form.template}
					onkeydown={handleTemplateKeyDown}
					rows="12"
					placeholder={m.snippets_template_placeholder({
						argumentsToken: '{{arguments}}',
						projectPathToken: '{{project_path}}',
					})}
					aria-invalid={Boolean(form.templateError)}
					aria-describedby="snippet-template-help snippet-template-error"
					class="min-h-48 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
				></textarea>
				<p id="snippet-template-help" class="text-xs text-muted-foreground">
					{m.snippets_template_help({
						argumentsToken: '{{arguments}}',
						projectPathToken: '{{project_path}}',
					})}
				</p>
				<p id="snippet-template-error" class="min-h-4 text-xs text-destructive">
					{form.templateError ?? ''}
				</p>
			</div>
		</div>

		{#if form.error}
			<p role="alert" class="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
				{form.error}
			</p>
		{/if}

		<Dialog.Footer>
			<Button variant="secondary" onclick={onClose} disabled={form.saving}>
				{m.snippets_cancel()}
			</Button>
			<Button onclick={() => void save()} disabled={!form.canSave}>
				{form.saving ? m.snippets_saving() : m.snippets_save()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
