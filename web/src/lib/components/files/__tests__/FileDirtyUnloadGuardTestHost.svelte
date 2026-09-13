<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { setFileSessions } from '$lib/context';
	import {
		FileDocumentState,
		type FileSaveOutcome,
	} from '$lib/files/documents/file-document-state.svelte.js';
	import { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
	import { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
	import FileDirtyUnloadGuard from '../FileDirtyUnloadGuard.svelte';
	import FileVimLoadError from '../FileVimLoadError.svelte';

	let {
		dirty,
		saveOutcome = 'idle',
		showVimError = false,
		onReload,
	}: {
		dirty: boolean;
		saveOutcome?: FileSaveOutcome;
		showVimError?: boolean;
		onReload?: () => void;
	} = $props();
	const initial = untrack(() => ({ dirty, saveOutcome }));
	const documentState = new FileDocumentState(
		{ canonicalFileRootPath: '/workspace', normalizedRelativePath: 'file.ts' },
		'["/workspace","file.ts"]',
	);
	const session = new FileViewSession(documentState, 'file-view');
	documentState.dirty = initial.dirty;
	documentState.saveOutcome = initial.saveOutcome;
	const files = new FileSessionRegistry({
		reloadApplication: () => onReload?.(),
		getIsMobile: () => false,
		getEditorSettings: () => ({ wordWrap: false, showLineNumbers: true, fontSize: 12 }),
		getDefaultPlacement: () => ({ type: 'dialog' }),
		getPlacement: () => ({
			placeFileSession: async () => 'cancelled',
			focusFileSession: async () => undefined,
		}),
	});
	files.sessions = { [session.id]: session };
	files.documents = { [documentState.id]: documentState };
	setFileSessions(files);

	$effect(() => {
		documentState.dirty = dirty;
		documentState.saveOutcome = saveOutcome;
	});

	onDestroy(() => {
		void files.destroyAll();
	});
</script>

<FileDirtyUnloadGuard />
{#if showVimError}<FileVimLoadError />{/if}
