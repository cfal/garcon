<script lang="ts">
	import { untrack } from 'svelte';
	import {
		setAppShell,
		setFileSessions,
		setSurfaceFrames,
		setWorkspaceCoordinator,
	} from '$lib/context';
	import { SurfaceFrameRegistry } from '$lib/workspace/surface-frame-registry.svelte';
	import { fileSurfaceId } from '$lib/workspace/surface-types';
	import { FileSession } from '$lib/files/sessions/file-session.svelte.js';
	import FileDialogHost from '../FileDialogHost.svelte';

	let {
		request,
		onResolve = () => undefined,
		isMobile = false,
	}: {
		request: 'guard' | 'refresh' | 'overwrite' | 'threshold' | 'file' | 'open-files';
		onResolve?: (choice: string) => void;
		isMobile?: boolean;
	} = $props();

	const initialRequest = untrack(() => request);
	const fileSession = new FileSession(
		{
			canonicalFileRootPath: '/workspace',
			normalizedRelativePath: 'assets/image.png',
		},
		'file-dialog-test',
	);
	fileSession.rendererMode = 'image';
	fileSession.contentKind = 'image';
	fileSession.loading = true;
	const dialogSurfaceId = initialRequest === 'file' ? fileSurfaceId(fileSession.id) : null;
	let guardRequest = $state(
		initialRequest === 'guard' || initialRequest === 'refresh'
			? {
					sessionId: 'file-session',
					fileName: 'dirty.ts',
					reason: initialRequest === 'refresh' ? ('refresh' as const) : ('close' as const),
				}
			: null,
	);
	let overwriteRequest = $state(
		initialRequest === 'overwrite'
			? { sessionId: 'file-session', fileName: 'dirty.ts' }
			: null,
	);
	let thresholdRequest = $state(
		initialRequest === 'threshold'
			? {
					identity: {
						canonicalFileRootPath: '/workspace',
						normalizedRelativePath: 'next.ts',
					},
					resolve: () => undefined,
				}
			: null,
	);
	let openFilesVisible = $state(initialRequest === 'open-files');

	setAppShell({
		get isMobile() {
			return isMobile;
		},
	} as never);
	setSurfaceFrames(new SurfaceFrameRegistry());
	setWorkspaceCoordinator({
		layout: {
			snapshot: { dialogFileSurfaceId: dialogSurfaceId },
			surface: (surfaceId: string) =>
				surfaceId === dialogSurfaceId
					? { id: surfaceId, type: 'file', fileSessionId: fileSession.id }
					: null,
		},
		attachmentErrors: {},
		closeSurface: async () => true,
		moveDialogFileToHost: async () => undefined,
		isSurfaceCloseBlocked: () => false,
		frameVersion: () => 0,
		retryPresentation: async () => undefined,
	} as never);
	setFileSessions({
		get guardRequest() {
			return guardRequest;
		},
		get thresholdRequest() {
			return thresholdRequest;
		},
		get overwriteRequest() {
			return overwriteRequest;
		},
		get openFilesVisible() {
			return openFilesVisible;
		},
		get all() {
			return initialRequest === 'file' ? [fileSession] : [];
		},
		get: (sessionId: string) => (sessionId === fileSession.id ? fileSession : null),
		resolveGuard: (choice: string) => {
			guardRequest = null;
			onResolve(choice);
		},
		resolveOverwrite: (choice: string) => {
			overwriteRequest = null;
			onResolve(choice);
		},
		resolveThreshold: (choice: string) => {
			thresholdRequest = null;
			onResolve(choice);
		},
		hideOpenFiles: () => {
			openFilesVisible = false;
		},
	} as never);
</script>

<FileDialogHost />
