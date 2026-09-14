<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { untrack } from 'svelte';
	import { EditorState } from '@codemirror/state';
	import { EditorView, lineNumbers } from '@codemirror/view';
	import { MergeView } from '@codemirror/merge';

	let {
		comparison,
		local = $bindable(),
		lineSeparator,
		readOnly = false,
	}: {
		comparison: string;
		local: string;
		lineSeparator: '\n' | '\r' | '\r\n';
		readOnly?: boolean;
	} = $props();
	let host = $state<HTMLDivElement | null>(null);
	let merge: MergeView | null = null;

	$effect(() => {
		const element = host;
		if (!element) return;
		merge?.destroy();
		const initialLocal = untrack(() => local);
		merge = new MergeView({
			a: {
				doc: comparison,
				extensions: [lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false)],
			},
			b: {
				doc: initialLocal,
				extensions: [
					lineNumbers(),
					EditorState.readOnly.of(readOnly),
					EditorView.editable.of(!readOnly),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) {
							const content = update.state.doc.toString();
							local = lineSeparator === '\n' ? content : content.replaceAll('\n', lineSeparator);
						}
					}),
				],
			},
			parent: element,
			highlightChanges: true,
			gutter: true,
			collapseUnchanged: { margin: 3, minSize: 8 },
		});
		return () => {
			merge?.destroy();
			merge = null;
		};
	});
</script>

<div
	bind:this={host}
	class="h-[min(50dvh,36rem)] min-h-64 overflow-auto rounded-md border border-border bg-card [&_.cm-editor]:min-w-0 [&_.cm-mergeView]:h-full [&_.cm-scroller]:overflow-auto"
	aria-label={m.file_conflict_comparison()}
></div>
