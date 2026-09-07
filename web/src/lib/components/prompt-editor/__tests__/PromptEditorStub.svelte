<script module lang="ts">
	let lastTextChange: ((text: string) => void) | null = null;

	export function emitLastPromptEditorTextChange(text: string): void {
		lastTextChange?.(text);
	}

	export function resetPromptEditorStub(): void {
		lastTextChange = null;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import type { PromptEditorSelection } from '$lib/prompt-editor/prompt-editor-selection.js';
	import {
		promptEditorSelectionFromTextarea,
		restorePromptEditorSelection,
	} from '$lib/prompt-editor/prompt-editor-selection.js';

	interface Props {
		text: string;
		selection: PromptEditorSelection;
		focusRequestId: number;
		readOnly: boolean;
		ariaLabel: string;
		onTextChange: (text: string) => void;
		onSelectionChange: (selection: PromptEditorSelection) => void;
	}

	let {
		text,
		selection,
		focusRequestId,
		readOnly,
		ariaLabel,
		onTextChange,
		onSelectionChange,
	}: Props = $props();
	let editor = $state<HTMLTextAreaElement | null>(null);

	$effect(() => {
		const handler = onTextChange;
		lastTextChange = handler;
		return () => {
			if (lastTextChange === handler) lastTextChange = null;
		};
	});

	onMount(() => {
		if (editor) restorePromptEditorSelection(editor, selection);
	});

	$effect(() => {
		const target = editor;
		focusRequestId;
		if (!target) return;
		restorePromptEditorSelection(target, selection);
		target.focus();
	});
</script>

<textarea
	bind:this={editor}
	value={text}
	readonly={readOnly}
	aria-label={ariaLabel}
	oninput={(event) => onTextChange(event.currentTarget.value)}
	onpointerup={(event) => onSelectionChange(promptEditorSelectionFromTextarea(event.currentTarget))}
></textarea>
