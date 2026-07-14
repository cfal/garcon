<script lang="ts">
	import { setLocalSettings } from '$lib/context';
	import { setSurfaceFrameBridge, SurfaceFrameBridge } from '$lib/workspace/surface-frame-context';
	import CodeEditor from '../CodeEditor.svelte';
	import type { FileSession } from '../file-session.svelte.js';

	let {
		focusRequestToken = 0,
		onFocus = () => undefined,
	}: {
		focusRequestToken?: number;
		onFocus?: () => void;
	} = $props();

	const frameBridge = new SurfaceFrameBridge();
	const session = {
		readOnly: false,
		showDiff: false,
		oldContent: null,
		editor: {
			attach: () => 1,
			detach: () => undefined,
			focus: onFocus,
			reconfigure: () => undefined,
		},
	} as unknown as FileSession;

	$effect(() => {
		if (focusRequestToken > 0) frameBridge.focusPrimary();
	});

	setSurfaceFrameBridge(() => frameBridge);
	setLocalSettings({
		codeEditorWordWrap: false,
		codeEditorLineNumbers: true,
		codeEditorFontSize: '12',
		codeEditorTheme: 'default',
	} as never);
</script>

<CodeEditor {session} />
