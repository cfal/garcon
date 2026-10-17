<script lang="ts">
	import TemplateVariableMenu from '$lib/components/prompt-editor/TemplateVariableMenu.svelte';
	import { RUNTIME_TEMPLATE_VARIABLES } from '$shared/template-tokens';
	import type { ScheduledPromptFormState } from './scheduled-prompt-form-state.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let { form, onkeydown }: { form: ScheduledPromptFormState; onkeydown: (event: KeyboardEvent) => void } = $props();
	const id = $props.id();
	let input = $state<HTMLInputElement | null>(null);
	const visibleError = $derived(form.customTitleTemplate ? form.titleError : null);
</script>

<div class="space-y-2">
	<label class="flex items-center gap-2 text-sm font-medium">
		<input type="checkbox" bind:checked={form.customTitleEnabled} disabled={form.saving} class="size-4 accent-primary" />
		{m.scheduled_prompts_custom_title()}
	</label>
	{#if form.customTitleEnabled}
		<div class="flex min-w-0 items-center gap-2">
			<input
				bind:this={input}
				bind:value={form.customTitleTemplate}
				aria-label={m.scheduled_prompts_chat_title()}
				aria-invalid={visibleError ? 'true' : undefined}
				aria-describedby={visibleError ? `${id}-error` : undefined}
				disabled={form.saving}
				{onkeydown}
				class="h-11 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
			/>
			<TemplateVariableMenu
				variables={RUNTIME_TEMPLATE_VARIABLES}
				getInput={() => input}
				onInsert={(value) => (form.customTitleTemplate = value)}
				disabled={form.saving}
			/>
		</div>
		{#if visibleError}
			<p id={`${id}-error`} class="text-xs text-destructive">{visibleError}</p>
		{/if}
	{/if}
</div>
