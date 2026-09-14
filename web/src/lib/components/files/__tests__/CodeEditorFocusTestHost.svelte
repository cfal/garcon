<script lang="ts">
	import { onDestroy } from 'svelte';
	import { setLocalSettings, setWorkspaceShortcuts } from '$lib/context';
	import { setSurfaceFrameBridge, SurfaceFrameBridge } from '$lib/workspace/surface-frame-context';
	import CodeEditor from '../CodeEditor.svelte';
	import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
	import type { WorkspaceShortcutDispatcher } from '$lib/workspace/workspace-shortcuts.js';

	let {
		focusRequestToken = 0,
		onFocus = () => undefined,
		closeDialog = () => false,
		closeSearch = () => false,
		vimOwnsKey = () => false,
		onRegisterShortcut = () => undefined,
	}: {
		focusRequestToken?: number;
		onFocus?: () => void;
		closeDialog?: () => boolean;
		closeSearch?: () => boolean;
		vimOwnsKey?: (event: KeyboardEvent) => boolean;
		onRegisterShortcut?: (handler: (event: KeyboardEvent) => boolean) => void;
	} = $props();

	const frameBridge = new SurfaceFrameBridge();
	void frameBridge.activate(false);
	const session = {
		readOnly: false,
		document: { mixedLineEndings: false },
		editor: {
			vim: { error: null, ownsKey: (event: KeyboardEvent) => vimOwnsKey(event) },
			attach: () => 1,
			detach: () => undefined,
			focus: () => onFocus(),
			closeDialog: () => closeDialog(),
			closeSearch: () => closeSearch(),
			reconfigure: () => undefined,
		},
	} as unknown as FileViewSession;

	$effect(() => {
		if (focusRequestToken > 0) frameBridge.focusPrimary();
	});

	setSurfaceFrameBridge(() => frameBridge);
	const shortcuts: Pick<WorkspaceShortcutDispatcher, 'registerLocalShortcutOwner'> = {
		registerLocalShortcutOwner: (
			_element: HTMLElement,
			handler: (event: KeyboardEvent) => boolean,
		) => {
			onRegisterShortcut(handler);
			return () => undefined;
		},
	};
	setWorkspaceShortcuts(shortcuts as WorkspaceShortcutDispatcher);
	setLocalSettings({
		codeEditorWordWrap: false,
		codeEditorLineNumbers: true,
		codeEditorFontSize: '12',
		codeEditorTheme: 'default',
	} as never);

	onDestroy(() => frameBridge.deactivate());
</script>

<section data-workspace-surface-id="file:test">
	<CodeEditor {session} />
</section>
