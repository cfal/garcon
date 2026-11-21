<script lang="ts">
	import { defaultKeymap } from '@codemirror/commands';
	import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
	import { Compartment, EditorState, Prec, Transaction } from '@codemirror/state';
	import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
	import { untrack } from 'svelte';
	import type { WorkflowSourceRange } from '$shared/workflow-definition';
	import * as m from '$lib/paraglide/messages.js';
	import { documentPosition } from '$lib/files/editor/file-document-runtime';
	import { loadLanguageExtension } from '$lib/highlighting/codemirror-language-registry';
	import { registerNativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region';
	import { applyWorkflowSourceChanges } from '$lib/workflows/definition/workflow-editor-source';

	let {
		source,
		selection,
		readOnly,
		onChange,
		onUndo,
		onRedo,
	}: {
		source: string;
		selection: WorkflowSourceRange | null;
		readOnly: boolean;
		onChange: (value: string) => void;
		onUndo: () => boolean;
		onRedo: () => boolean;
	} = $props();

	const lock = new Compartment();
	const language = new Compartment();
	let host = $state<HTMLDivElement>();
	let view = $state.raw<EditorView>();
	let exactSource = '';
	const readonlyExtension = () => [
		EditorState.readOnly.of(readOnly),
		EditorView.editable.of(!readOnly),
	];

	$effect(() => {
		const parent = host;
		if (!parent) return;
		const editor = untrack(() => {
			exactSource = source;
			return new EditorView({
				parent,
				state: EditorState.create({
					doc: source,
					extensions: [
						lock.of(readonlyExtension()),
						language.of([]),
						lineNumbers(),
						bracketMatching(),
						highlightActiveLine(),
						syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
						EditorView.contentAttributes.of({
							'aria-label': m.workflow_studio_source(),
							'aria-multiline': 'true',
							spellcheck: 'false',
						}),
						Prec.high(
							keymap.of([
								{ key: 'Mod-z', run: () => onUndo() },
								{ key: 'Mod-Shift-z', run: () => onRedo() },
								{ key: 'Mod-y', run: () => onRedo() },
							]),
						),
						keymap.of(defaultKeymap),
						EditorView.updateListener.of((update) => {
							if (
								!update.docChanged ||
								update.transactions.every((tx) => tx.annotation(Transaction.remote))
							)
								return;
							exactSource = applyWorkflowSourceChanges(
								exactSource,
								update.startState.doc,
								update.changes,
							);
							onChange(exactSource);
						}),
					],
				}),
			});
		});
		view = editor;
		const unregister = registerNativeWorkspaceScrollRegion(editor.scrollDOM, 'primary');
		void loadLanguageExtension('definition.workflow.yaml').then((extensions) => {
			if (view === editor) editor.dispatch({ effects: language.reconfigure(extensions) });
		});
		return () => {
			view = undefined;
			unregister();
			editor.destroy();
		};
	});

	$effect(() => {
		const editor = view;
		if (!editor || source === exactSource) return;
		exactSource = source;
		const next = editor.state.toText(source);
		if (!editor.state.doc.eq(next)) {
			editor.dispatch({
				changes: { from: 0, to: editor.state.doc.length, insert: next },
				annotations: Transaction.remote.of(true),
			});
		}
	});

	$effect(() => {
		view?.dispatch({ effects: lock.reconfigure(readonlyExtension()) });
	});

	$effect(() => {
		const editor = view;
		const selected = selection;
		if (!editor || !selected) return;
		const { doc } = editor.state;
		const anchor = documentPosition(doc, selected.start.line, selected.start.column);
		const head = documentPosition(doc, selected.end.line, selected.end.column);
		editor.dispatch({ selection: { anchor, head }, scrollIntoView: true });
		editor.focus();
	});
</script>

<div
	bind:this={host}
	class="min-h-40 flex-1 overflow-hidden text-base [&_.cm-activeLine]:bg-muted/45 [&_.cm-content]:font-mono [&_.cm-editor]:h-full [&_.cm-gutters]:border-border [&_.cm-gutters]:bg-muted [&_.cm-gutters]:text-muted-foreground [&_.cm-scroller]:overflow-auto pointer-fine:text-sm"
></div>
