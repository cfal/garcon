<script lang="ts">
	import { untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { getWorkspaceShortcuts } from '$lib/context';
	import {
		ComposerEditorController,
		type ComposerEditorControllerOptions,
	} from '$lib/chat/composer/composer-editor-controller.js';
	import type { ComposerEditorSelection } from '$lib/chat/composer/composer-editor-selection.js';

	interface Props {
		text: string;
		selection: ComposerEditorSelection;
		focusRequestId: number;
		ariaLabel: string;
		onTextChange: (text: string) => void;
		onSelectionChange: (selection: ComposerEditorSelection) => void;
	}

	let { text, selection, focusRequestId, ariaLabel, onTextChange, onSelectionChange }: Props =
		$props();
	const workspaceShortcuts = getWorkspaceShortcuts();
	let controller = $state<ComposerEditorController | null>(null);

	const attachEditor: Attachment<HTMLDivElement> = (element) => {
		const initial = untrack(() => ({ text, selection, ariaLabel }));
		const options: ComposerEditorControllerOptions = {
			initialText: initial.text,
			initialSelection: initial.selection,
			ariaLabel: initial.ariaLabel,
			workspaceShortcuts,
			onTextChange: (nextText) => onTextChange(nextText),
			onSelectionChange: (nextSelection) => onSelectionChange(nextSelection),
		};
		const attachedController = new ComposerEditorController(element, options);
		controller = attachedController;
		queueMicrotask(() => attachedController.focus());
		return () => {
			if (controller === attachedController) controller = null;
			attachedController.destroy();
		};
	};

	$effect(() => {
		const activeController = controller;
		const nextText = text;
		activeController?.syncText(nextText);
	});

	$effect(() => {
		const activeController = controller;
		focusRequestId;
		activeController?.focus();
	});
</script>

<div class="h-full min-h-0 overflow-hidden" data-composer-editor>
	<div class="h-full [&_.cm-editor]:h-full" {@attach attachEditor}></div>
</div>
