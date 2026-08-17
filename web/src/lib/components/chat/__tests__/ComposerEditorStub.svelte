<script module lang="ts">
	let lastTextChange: ((text: string) => void) | null = null;

	export function emitLastComposerEditorTextChange(text: string): void {
		lastTextChange?.(text);
	}

	export function resetComposerEditorStub(): void {
		lastTextChange = null;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import type { ComposerEditorSelection } from '$lib/chat/composer/composer-editor-selection.js';
	import {
		composerEditorSelectionFromTextarea,
		restoreComposerEditorSelection,
	} from '$lib/chat/composer/composer-editor-selection.js';

	interface Props {
		text: string;
		selection: ComposerEditorSelection;
		focusRequestId: number;
		readOnly: boolean;
		ariaLabel: string;
		onTextChange: (text: string) => void;
		onSelectionChange: (selection: ComposerEditorSelection) => void;
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
		if (editor) restoreComposerEditorSelection(editor, selection);
	});

	$effect(() => {
		const target = editor;
		focusRequestId;
		if (!target) return;
		restoreComposerEditorSelection(target, selection);
		target.focus();
	});
</script>

<textarea
	bind:this={editor}
	value={text}
	readonly={readOnly}
	aria-label={ariaLabel}
	oninput={(event) => onTextChange(event.currentTarget.value)}
	onpointerup={(event) =>
		onSelectionChange(composerEditorSelectionFromTextarea(event.currentTarget))}></textarea>
