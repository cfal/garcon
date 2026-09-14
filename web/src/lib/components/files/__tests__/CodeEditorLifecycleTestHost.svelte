<script lang="ts">
	import { untrack } from 'svelte';
	import { setLocalSettings } from '$lib/context';
	import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
	import {
		setSurfaceFrameBridge,
		type SurfaceFrameBridge,
	} from '$lib/workspace/surface-frame-context.js';
	import CodeEditor from '../CodeEditor.svelte';
	import FileEditorStatus from '../FileEditorStatus.svelte';

	let {
		session,
		settings,
		bridge,
	}: {
		session: FileViewSession;
		settings: LocalSettingsStore;
		bridge: SurfaceFrameBridge;
	} = $props();
	setLocalSettings(untrack(() => settings));
	setSurfaceFrameBridge(() => bridge);
</script>

<CodeEditor {session} />
<FileEditorStatus {session} />
