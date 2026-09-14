<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import {
		setFileSessions,
		setLocalSettings,
		setNotifications,
		setWorkspaceLayout,
		setWorkbenchCommands,
	} from '$lib/context';
	import { FileSession } from '$lib/files/sessions/__tests__/file-session-fixture.js';
	import {
		FileSessionRegistry,
		type FileOpenRequest,
	} from '$lib/files/sessions/file-session-registry.svelte.js';
	import { CodeEditorController } from '$lib/files/editor/code-editor-controller.svelte.js';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
	import type { PresentationHostId } from '$lib/workspace/surface-types.js';
	import { setSurfaceFrameBridge, SurfaceFrameBridge } from '$lib/workspace/surface-frame-context';
	import { createWorkspaceLayoutStore } from '$lib/workspace/workspace-layout.svelte.js';
	import FileSurface from '../FileSurface.svelte';
	import type { WorkbenchCommandRegistry } from '$lib/workspace/workbench-commands.svelte.js';

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
		onOpen = () => {},
		onReady,
		onClose,
		closeDisabled = false,
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
		onOpen?: (request: FileOpenRequest) => void;
		onReady?: (session: FileSession, frame: SurfaceFrameBridge) => void;
		onClose?: () => void;
		closeDisabled?: boolean;
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
	const notifications = createNotificationsStore();
	const workspaceLayout = createWorkspaceLayoutStore();

	const fileSessions = new FileSessionRegistry({
		getIsMobile: () => presentation === 'mobile',
		getDefaultPlacement: () => ({ type: 'dialog' }),
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
	fileSessions.open = async (request) => {
		onOpen(request);
		return null;
	};
	fileSessions.showSource = async (sessionId) => {
		if (sessionId !== session.id) return false;
		session.markdownMode = 'source';
		session.rendererMode = 'code';
		return Boolean(session.editor);
	};

	localSettings.codeEditorWordWrap = false;
	localSettings.codeEditorLineNumbers = true;
	localSettings.codeEditorFontSize = '12';
	localSettings.markdownViewerFontSize = '14';

	let relativePath = 'src/file.ts';
	let contentKind: FileSession['contentKind'] = 'text';
	if (initial.rendererMode === 'image') {
		relativePath = 'assets/image.png';
		contentKind = 'image';
	} else if (initial.rendererMode === 'markdown') {
		relativePath = 'docs/current.md';
		contentKind = 'markdown';
	}
	const session = new FileSession(
		{
			canonicalFileRootPath: '/workspace',
			normalizedRelativePath: relativePath,
		},
		'file-surface-test',
	);
	session.contentKind = contentKind;
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
			editorThemeId: 'standard-light',
			get wordWrap() {
				return localSettings.codeEditorWordWrap;
			},
			get showLineNumbers() {
				return localSettings.codeEditorLineNumbers;
			},
			get fontSize() {
				return Number(localSettings.codeEditorFontSize);
			},
			get vimMode() {
				return localSettings.codeEditorVimMode;
			},
		});
	}

	setSurfaceFrameBridge(() => frameBridge);
	setFileSessions(fileSessions);
	setLocalSettings(localSettings);
	setNotifications(notifications);
	setWorkspaceLayout(workspaceLayout);
	const commands: Pick<WorkbenchCommandRegistry, 'execute' | 'registerFileSurface'> = {
		execute: async (id, context) =>
			id === 'file.save' && context?.viewId ? fileSessions.save(context.viewId) : false,
		registerFileSurface: () => () => undefined,
	};
	setWorkbenchCommands(commands as WorkbenchCommandRegistry);
	onMount(() => onReady?.(session, frameBridge));
	onDestroy(() => {
		frameBridge.deactivate();
		session.editor?.dispose();
		localSettings.destroy();
	});
</script>

<FileSurface {session} {presentation} {onClose} {closeDisabled} />
