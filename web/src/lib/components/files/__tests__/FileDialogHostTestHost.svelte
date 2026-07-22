<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import {
		setAppShell,
		setFileSessions,
		setLocalSettings,
		setSurfaceFrames,
		setWorkspaceCoordinator,
	} from '$lib/context';
	import { SurfaceFrameRegistry } from '$lib/workspace/surface-frame-registry.svelte';
	import { fileSurfaceId } from '$lib/workspace/surface-types';
	import { FileSession } from '$lib/files/sessions/file-session.svelte.js';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import FileDialogHost from '../FileDialogHost.svelte';
	import {
		DEFAULT_DESKTOP_LAYOUT_ORDER,
		type DesktopLayoutOrder,
	} from '$lib/layout/desktop-layout.js';

	let {
		request,
		onResolve = () => undefined,
		isMobile = false,
		desktopLayoutOrder = DEFAULT_DESKTOP_LAYOUT_ORDER,
	}: {
		request: 'guard' | 'refresh' | 'overwrite' | 'threshold' | 'file' | 'open-files';
		onResolve?: (choice: string) => void;
		isMobile?: boolean;
		desktopLayoutOrder?: DesktopLayoutOrder;
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
		initialRequest === 'overwrite' ? { sessionId: 'file-session', fileName: 'dirty.ts' } : null,
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
	const localSettings = createLocalSettingsStore();

	$effect(() => {
		localSettings.desktopLayoutOrder = [...desktopLayoutOrder];
	});

	setAppShell({
		get isMobile() {
			return isMobile;
		},
	} as never);
	setLocalSettings(localSettings);
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
	onDestroy(() => localSettings.destroy());
</script>

<FileDialogHost />
