<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { setFileSessions, setLocalSettings } from '$lib/context';
	import { FileSession } from '$lib/files/sessions/file-session.svelte.js';
	import {
		FileSessionRegistry,
		type FileOpenRequest,
	} from '$lib/files/sessions/file-session-registry.svelte.js';
	import { CodeEditorController } from '$lib/files/editor/code-editor-controller.svelte.js';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import type { PresentationHostId } from '$lib/workspace/surface-types.js';
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
		content = '# Heading',
		onRefresh = () => undefined,
		onCheckFreshness = () => undefined,
		onOpen = () => {},
	}: {
		presentation: PresentationHostId;
		rendererMode?: 'code' | 'markdown' | 'image';
		loading?: boolean;
		stale?: boolean;
		refreshing?: boolean;
		dirty?: boolean;
		refreshError?: string | null;
		content?: string;
		onRefresh?: (sessionId: string) => void;
		onCheckFreshness?: (sessionId: string) => void;
		onOpen?: (request: FileOpenRequest) => void;
	} = $props();
	const initial = untrack(() => ({
		rendererMode,
		loading,
		stale,
		refreshing,
		dirty,
		refreshError,
		content,
	}));
	const frameBridge = new SurfaceFrameBridge();
	const localSettings = createLocalSettingsStore();

	const fileSessions = new FileSessionRegistry({
		getIsMobile: () => presentation === 'mobile',
		getDefaultPlacement: () => 'dialog',
		getEditorSettings: () => ({
			wordWrap: false,
			showLineNumbers: true,
			fontSize: 12,
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
	fileSessions.open = async (request) => {
		onOpen(request);
		return null;
	};

	localSettings.codeEditorWordWrap = false;
	localSettings.codeEditorLineNumbers = true;
	localSettings.codeEditorFontSize = '12';
	localSettings.markdownViewerFontSize = '14';

	const session = new FileSession(
		{
			canonicalFileRootPath: '/workspace',
			normalizedRelativePath:
				initial.rendererMode === 'image'
					? 'assets/image.png'
					: initial.rendererMode === 'markdown'
						? 'docs/current.md'
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
	session.content = initial.content;
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
	setLocalSettings(localSettings);
	onDestroy(() => localSettings.destroy());
</script>

<FileSurface {session} {presentation} />
