<script lang="ts">
	import { untrack } from 'svelte';
	import { setFileSessions, setLocalSettings } from '$lib/context';
	import { FileSession } from '$lib/files/sessions/file-session.svelte.js';
	import { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
	import { CodeEditorController } from '$lib/files/editor/code-editor-controller.svelte.js';
	import { setSurfaceFrameBridge, SurfaceFrameBridge } from '$lib/workspace/surface-frame-context';
	import FileSurface from '../FileSurface.svelte';

	let {
		presentation,
		rendererMode = 'image',
		loading = true,
		stale = false,
		refreshing = false,
		dirty = false,
		refreshError = null,
		onRefresh = () => undefined,
		onCheckFreshness = () => undefined,
	}: {
		presentation: 'main' | 'mobile';
		rendererMode?: 'code' | 'markdown' | 'image';
		loading?: boolean;
		stale?: boolean;
		refreshing?: boolean;
		dirty?: boolean;
		refreshError?: string | null;
		onRefresh?: (sessionId: string) => void;
		onCheckFreshness?: (sessionId: string) => void;
	} = $props();
	const initial = untrack(() => ({ rendererMode, loading, stale, refreshing, dirty, refreshError }));
	const frameBridge = new SurfaceFrameBridge();

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
	fileSessions.refresh = async (sessionId: string) => onRefresh(sessionId);
	fileSessions.checkFreshness = async (sessionId: string) => onCheckFreshness(sessionId);
	setLocalSettings({
		codeEditorWordWrap: false,
		codeEditorLineNumbers: true,
		codeEditorFontSize: '12',
		codeEditorTheme: 'default',
		markdownViewerFontSize: '14',
	} as never);
	const session = new FileSession(
		{
			canonicalFileRootPath: '/workspace',
			normalizedRelativePath:
				initial.rendererMode === 'image'
					? 'assets/image.png'
					: initial.rendererMode === 'markdown'
						? 'README.md'
						: 'src/file.ts',
		},
		'file-surface-test',
	);
	session.contentKind =
		initial.rendererMode === 'image'
			? 'image'
			: initial.rendererMode === 'markdown'
				? 'markdown'
				: 'text';
	session.rendererMode = initial.rendererMode;
	session.loading = initial.loading;
	session.loadedRevision = 'v1:loaded';
	session.isExternallyStale = initial.stale;
	session.refreshing = initial.refreshing;
	session.dirty = initial.dirty;
	session.refreshError = initial.refreshError;
	session.content = '# Heading';
	session.baseline = session.content;
	if (session.rendererMode !== 'image') {
		session.editor = new CodeEditorController(session, {
			isDark: false,
			wordWrap: false,
			showLineNumbers: true,
			fontSize: 12,
		});
	}

	setSurfaceFrameBridge(() => frameBridge);
	setFileSessions(fileSessions);
</script>

<FileSurface {session} {presentation} />
