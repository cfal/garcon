<script lang="ts">
	import { tick } from 'svelte';
	import Braces from '@lucide/svelte/icons/braces';
	import { buttonVariants } from '$lib/components/ui/button';
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
		DropdownMenuItem,
	} from '$lib/components/ui/dropdown-menu';
	import type { SnippetTemplateVariable } from '$shared/snippets';
	import * as m from '$lib/paraglide/messages.js';

	type TextInput = HTMLInputElement | HTMLTextAreaElement;
	interface Props {
		variables: readonly SnippetTemplateVariable[];
		getInput: () => TextInput | null;
		onInsert: (value: string) => void;
		disabled?: boolean;
	}
	let { variables, getInput, onInsert, disabled = false }: Props = $props();
	let selection: { input: TextInput; text: string; start: number; end: number } | null = null;
	let inserted: { input: TextInput; text: string; caret: number } | null = null;

	function capture(open: boolean): void {
		if (!open) return;
		inserted = null;
		const input = getInput();
		selection = input ? {
			input, text: input.value,
			start: input.selectionStart ?? input.value.length,
			end: input.selectionEnd ?? input.value.length,
		} : null;
	}

	function insert(variable: SnippetTemplateVariable): void {
		if (disabled || !selection || selection.input !== getInput() || selection.input.value !== selection.text) return;
		const { input, text, start, end } = selection;
		const token = `{{${variable}}}`;
		const next = text.slice(0, start) + token + text.slice(end);
		inserted = { input, text: next, caret: start + token.length };
		input.value = next;
		onInsert(next);
	}

	async function restoreFocus(event: Event): Promise<void> {
		const target = inserted;
		if (!target) return;
		event.preventDefault();
		inserted = null;
		await tick();
		if (target.input !== getInput() || !target.input.isConnected || target.input.value !== target.text) return;
		target.input.focus({ preventScroll: true });
		target.input.setSelectionRange(target.caret, target.caret);
	}

	function label(variable: SnippetTemplateVariable): string {
		switch (variable) {
			case 'chat_id': return m.template_variable_chat_id();
			case 'current_date': return m.template_variable_date_utc();
			case 'current_date_local': return m.template_variable_date_local();
			case 'arguments': return m.template_variable_arguments();
			case 'project_path': return m.template_variable_project_path();
		}
	}
</script>

<DropdownMenu onOpenChange={capture}>
	<DropdownMenuTrigger
		class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
		{disabled}
		title={m.template_variable_insert()}
		aria-label={m.template_variable_insert()}
	>
		<Braces class="size-4" />
	</DropdownMenuTrigger>
	<DropdownMenuContent align="end" onCloseAutoFocus={(event) => void restoreFocus(event)}>
		{#each variables as variable (variable)}
			<DropdownMenuItem onSelect={() => insert(variable)}>
				<span class="flex min-w-0 flex-col gap-0.5">
					<span>{label(variable)}</span>
					<code class="text-xs text-muted-foreground">{`{{${variable}}}`}</code>
				</span>
			</DropdownMenuItem>
		{/each}
	</DropdownMenuContent>
</DropdownMenu>
