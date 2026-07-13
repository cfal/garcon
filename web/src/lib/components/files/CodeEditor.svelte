<script lang="ts">
	import type { FileSession } from './file-session.svelte.js';
	import { getLocalSettings } from '$lib/context';
	import { getSurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';

	let { session }: { session: FileSession } = $props();
	const localSettings = getLocalSettings();
	const frame = getSurfaceFrameBridge();
	let editorContainer = $state<HTMLDivElement | null>(null);
	let lease: number | null = null;

	$effect(() => {
		const controller = session.editor;
		const element = editorContainer;
		if (!controller || !element) return;
		const detach = () => {
			if (lease !== null) controller.detach(lease);
			lease = null;
		};
		return frame.provideRenderer({
			attach: () => {
				detach();
				lease = controller.attach(element);
			},
			detach,
			focusPrimary: () => controller.focus(),
		});
	});

	$effect(() => {
		localSettings.codeEditorWordWrap;
		localSettings.codeEditorLineNumbers;
		localSettings.codeEditorFontSize;
		localSettings.codeEditorTheme;
		session.readOnly;
		session.showDiff;
		session.oldContent;
		session.editor?.reconfigure();
	});
</script>

<div class="h-full min-h-0 overflow-hidden">
	<div
		bind:this={editorContainer}
		class="h-full [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
	></div>
</div>
