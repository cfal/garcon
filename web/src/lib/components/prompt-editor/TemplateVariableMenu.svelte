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
	import * as m from '$lib/paraglide/messages.js';

	type TextInput = HTMLInputElement | HTMLTextAreaElement;
	interface Props {
		variables: readonly string[];
		getInput: () => TextInput | null;
		onInsert: (value: string) => void;
		disabled?: boolean;
	}
	let { variables, getInput, onInsert, disabled = false }: Props = $props();
	let selection: { input: TextInput; text: string; start: number; end: number } | null = null;
	let pendingInsertion: { input: TextInput; text: string; caret: number } | null = null;

	function captureSelection(open: boolean): void {
		if (!open) return;
		pendingInsertion = null;
		const input = getInput();
		if (!input) {
			selection = null;
			return;
		}
		selection = {
			input,
			text: input.value,
			start: input.selectionStart ?? input.value.length,
			end: input.selectionEnd ?? input.value.length,
		};
	}

	function insertVariable(variable: string): void {
		if (disabled || !selection) return;
		const { input, text, start, end } = selection;
		if (input !== getInput() || input.value !== text) return;
		const token = `{{${variable}}}`;
		const nextText = text.slice(0, start) + token + text.slice(end);
		pendingInsertion = { input, text: nextText, caret: start + token.length };
		input.value = nextText;
		onInsert(nextText);
	}

	async function restoreInputFocus(event: Event): Promise<void> {
		if (!pendingInsertion) return;
		const { input, text, caret } = pendingInsertion;
		event.preventDefault();
		pendingInsertion = null;
		await tick();
		if (input !== getInput() || !input.isConnected || input.value !== text) return;
		input.focus({ preventScroll: true });
		input.setSelectionRange(caret, caret);
	}

	function variableLabel(variable: string): string {
		switch (variable) {
			case 'chat_id':
				return m.template_variable_chat_id();
			case 'current_date':
				return m.template_variable_date_utc();
			case 'current_date_local':
				return m.template_variable_date_local();
			case 'arguments':
				return m.template_variable_arguments();
			case 'project_path':
				return m.template_variable_project_path();
			case 'repository':
				return m.template_variable_repository();
			case 'repository_url':
				return m.template_variable_repository_url();
			case 'pull_request_number':
				return m.template_variable_pull_request_number();
			default:
				return `{{${variable}}}`;
		}
	}
</script>

<DropdownMenu onOpenChange={captureSelection}>
	<DropdownMenuTrigger
		class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
		{disabled}
		title={m.template_variable_insert()}
		aria-label={m.template_variable_insert()}
	>
		<Braces class="size-4" />
	</DropdownMenuTrigger>
	<DropdownMenuContent align="end" onCloseAutoFocus={(event) => void restoreInputFocus(event)}>
		{#each variables as variable (variable)}
			<DropdownMenuItem onSelect={() => insertVariable(variable)}>
				<span class="flex min-w-0 flex-col gap-0.5">
					<span>{variableLabel(variable)}</span>
					<code class="text-xs text-muted-foreground">{`{{${variable}}}`}</code>
				</span>
			</DropdownMenuItem>
		{/each}
	</DropdownMenuContent>
</DropdownMenu>
