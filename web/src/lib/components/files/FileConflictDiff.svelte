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
		onReady,
	}: {
		comparison: string;
		local: string;
		lineSeparator: '\n' | '\r' | '\r\n';
		onReady?(ready: boolean): void;
	} = $props();
	let host = $state<HTMLDivElement | null>(null);
	const comparisonLabel = m.file_conflict_snapshot_label();
	const localLabel = m.file_conflict_resolution_label();

	$effect(() => {
		const element = host;
		if (!element) return;
		const initialLocal = untrack(() => local);
		const merge = new MergeView({
			a: {
				doc: comparison,
				extensions: [
					lineNumbers(),
					EditorState.readOnly.of(true),
					EditorView.editable.of(false),
					EditorView.contentAttributes.of({ 'aria-label': comparisonLabel }),
				],
			},
			b: {
				doc: initialLocal,
				extensions: [
					lineNumbers(),
					EditorView.contentAttributes.of({ 'aria-label': localLabel }),
					EditorState.readOnly.of(false),
					EditorView.editable.of(true),
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
		untrack(() => onReady?.(true));
		return () => {
			onReady?.(false);
			merge.destroy();
		};
	});
</script>

<div
	bind:this={host}
	class="h-[min(50dvh,36rem)] min-h-64 overflow-auto rounded-md border border-border bg-card [&_.cm-editor]:min-w-0 [&_.cm-mergeView]:h-full [&_.cm-scroller]:overflow-auto"
	aria-label={m.file_conflict_comparison()}
	role="group"
></div>
