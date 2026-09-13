<script lang="ts">
	import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
	import { getLocalSettings, getOptionalWorkspaceShortcuts } from '$lib/context';
	import { getSurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
	import { registerNativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';

	let { session }: { session: FileViewSession } = $props();
	const localSettings = getLocalSettings();
	const shortcuts = getOptionalWorkspaceShortcuts();
	const frame = getSurfaceFrameBridge();
	let editorContainer = $state<HTMLDivElement | null>(null);
	let lease: number | null = null;
	let unregisterScrollRegion: (() => void) | null = null;

	$effect(() => {
		const controller = session.editor;
		const element = editorContainer;
		if (!controller || !element) return;
		const detach = () => {
			unregisterScrollRegion?.();
			unregisterScrollRegion = null;
			if (lease !== null) controller.detach(lease);
			lease = null;
		};
		return frame.provideRenderer({
			attach: () => {
				detach();
				lease = controller.attach(element);
				const scrollElement = controller.scrollElement;
				if (scrollElement) {
					unregisterScrollRegion = registerNativeWorkspaceScrollRegion(scrollElement, 'primary');
				}
			},
			detach,
			focusPrimary: () => controller.focus(),
		});
	});

	$effect(() => {
		const element = editorContainer;
		if (!shortcuts || !element) return;
		return shortcuts.registerLocalShortcutOwner(element, (event) => {
			if (event.isComposing) return false;
			if (event.key !== 'Escape') return false;
			const consume = () => {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				return true;
			};
			if (session.editor?.closeDialog() || session.editor?.closeSearch()) return consume();
			const surface = element.closest<HTMLElement>('[data-workspace-surface-id]');
			if (!surface) return false;
			surface.tabIndex = -1;
			surface.focus();
			return consume();
		});
	});

	$effect(() => {
		localSettings.codeEditorWordWrap;
		localSettings.codeEditorLineNumbers;
		localSettings.codeEditorFontSize;
		session.readOnly;
		session.document.mixedLineEndings;
		session.editor?.reconfigure();
	});
</script>

<div class="h-full min-h-0 overflow-hidden">
	<div
		bind:this={editorContainer}
		class="h-full [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
	></div>
</div>
