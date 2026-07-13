<script lang="ts">
	import type { HostId } from '$lib/workspace/surface-types';
	import { setTerminalRegistry, setWorkspaceCoordinator } from '$lib/context';
	import { setSurfaceFrameBridge, SurfaceFrameBridge } from '$lib/workspace/surface-frame-context';
	import TerminalSurface from '../TerminalSurface.svelte';

	interface Props {
		host: HostId | 'mobile';
		onClose?: (surfaceId: string) => void;
		onModifier?: (modifier: 'ctrl' | 'alt') => void;
		onToolbarKey?: (key: string) => void;
		createError?: Error | null;
	}

	let {
		host,
		onClose = () => undefined,
		onModifier = () => undefined,
		onToolbarKey = () => undefined,
		createError = null,
	}: Props = $props();
	const terminalId = 'terminal-1';
	const session = {
		metadata: {
			terminalId,
			displaySequence: 1,
			initialWorkingDirectory: '/workspace/project',
			processStatus: 'running',
			attachmentStatus: 'attached',
			createdAt: '2026-07-13T00:00:00.000Z',
			exitCode: null,
			latestOutputSequence: 0,
		},
		attachmentState: 'attached',
		replayTruncatedAt: null,
	};
	const runtime = {
		inputControls: {
			ctrlMode: 'inactive',
			altMode: 'inactive',
			toggleModifier: (modifier: 'ctrl' | 'alt') => onModifier(modifier),
		},
		sendToolbarKey: (key: string) => onToolbarKey(key),
		attach: () => 1,
		park: () => undefined,
		scheduleFit: () => undefined,
		focus: () => undefined,
		pasteFromClipboard: () => Promise.resolve(),
	};
	const frameBridge = new SurfaceFrameBridge();

	setSurfaceFrameBridge(() => frameBridge);
	setTerminalRegistry({
		sessions: { [terminalId]: session },
		orderedSessions: [session],
		listStatus: 'ready',
		listError: null,
		runtime: () => runtime,
		reattach: () => undefined,
		list: () => Promise.resolve(),
	} as never);
	setWorkspaceCoordinator({
		openTerminalSession: () => Promise.resolve(),
		createTerminal: () =>
			createError ? Promise.reject(createError) : Promise.resolve('terminal-2'),
		closeSurface: async (surfaceId: string) => {
			onClose(surfaceId);
			return true;
		},
		isSurfaceCloseBlocked: () => false,
	} as never);
</script>

<TerminalSurface {terminalId} {host} />
