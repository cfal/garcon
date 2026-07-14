<script lang="ts">
	import { untrack } from 'svelte';
	import {
		setAppShell,
		setFileSessions,
		setSurfaceFrames,
		setWorkspaceCoordinator,
	} from '$lib/context';
	import { SurfaceFrameRegistry } from '$lib/workspace/surface-frame-registry.svelte';
	import FileDialogHost from '../FileDialogHost.svelte';

	let {
		request,
		onResolve,
	}: {
		request: 'guard' | 'threshold';
		onResolve: (choice: string) => void;
	} = $props();

	const initialRequest = untrack(() => request);
	let guardRequest = $state(
		initialRequest === 'guard'
			? { sessionId: 'file-session', fileName: 'dirty.ts', reason: 'close' as const }
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
	let openFilesVisible = $state(false);

	setAppShell({ isMobile: false } as never);
	setSurfaceFrames(new SurfaceFrameRegistry());
	setWorkspaceCoordinator({
		layout: {
			snapshot: { dialogFileSurfaceId: null },
			surface: () => null,
		},
	} as never);
	setFileSessions({
		get guardRequest() {
			return guardRequest;
		},
		get thresholdRequest() {
			return thresholdRequest;
		},
		get openFilesVisible() {
			return openFilesVisible;
		},
		get all() {
			return [];
		},
		get: () => null,
		resolveGuard: (choice: string) => {
			guardRequest = null;
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
