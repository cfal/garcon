<script lang="ts">
	import { setFileSessions } from '$lib/context';
	import { FileSession } from '$lib/files/sessions/file-session.svelte.js';
	import { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
	import FileSurface from '../FileSurface.svelte';

	let {
		presentation,
	}: {
		presentation: 'main' | 'mobile';
	} = $props();

	const fileSessions = new FileSessionRegistry({
		getIsMobile: () => presentation === 'mobile',
		getDefaultPlacement: () => 'dialog',
		getEditorSettings: () => ({
			get wordWrap() {
				return false;
			},
			get showLineNumbers() {
				return true;
			},
			get fontSize() {
				return 12;
			},
		}),
		getPlacement: () => ({
			async placeFileSession(_sessionId, _target, publication) {
				publication.publish();
				return 'placed';
			},
			async focusFileSession() {},
		}),
		resolveFileIdentity: async ({ relativePath }) => ({
			success: true,
			identity: {
				canonicalFileRootPath: '/workspace',
				normalizedRelativePath: relativePath,
			},
		}),
		readText: async () => ({ content: '', path: '/workspace/file.ts', revision: 'v1:loaded' }),
		saveText: async () => ({
			success: true,
			path: '/workspace/file.ts',
			message: 'saved',
			revision: 'v1:saved',
		}),
		readContent: async () => ({ blob: new Blob(), revision: 'v1:image' }),
	});
	const session = new FileSession(
		{
			canonicalFileRootPath: '/workspace',
			normalizedRelativePath: 'assets/image.png',
		},
		'file-surface-test',
	);
	session.contentKind = 'image';
	session.rendererMode = 'image';
	session.loading = true;

	setFileSessions(fileSessions);
</script>

<FileSurface {session} {presentation} />
