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
		onSwitch?: (currentTerminalId: string, nextTerminalId: string) => void;
		onCreateReplacing?: (currentTerminalId: string) => void;
		onTerminate?: (terminalId: string) => void;
		createError?: Error | null;
	}

	let {
		host,
		onClose = () => undefined,
		onModifier = () => undefined,
		onToolbarKey = () => undefined,
		onSwitch = () => undefined,
		onCreateReplacing = () => undefined,
		onTerminate = () => undefined,
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
	const secondSession = {
		...session,
		metadata: { ...session.metadata, terminalId: 'terminal-2', displaySequence: 2 },
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
		sessions: { [terminalId]: session, 'terminal-2': secondSession },
		orderedSessions: [session, secondSession],
		listStatus: 'ready',
		listError: null,
		runtime: () => runtime,
		reattach: () => undefined,
		list: () => Promise.resolve(),
	} as never);
	setWorkspaceCoordinator({
		layout: {
			snapshot: {
				main: { order: ['terminal:terminal-1'] },
				sidebar: { order: [] },
			},
		},
		switchTerminalSurface: async (currentTerminalId: string, nextTerminalId: string) => {
			onSwitch(currentTerminalId, nextTerminalId);
		},
		createTerminalReplacing: (currentTerminalId: string) => {
			onCreateReplacing(currentTerminalId);
			return createError ? Promise.reject(createError) : Promise.resolve('terminal-2');
		},
		terminateTerminalSession: async (selectedTerminalId: string) => {
			onTerminate(selectedTerminalId);
			return true;
		},
		closeSurface: async (surfaceId: string) => {
			onClose(surfaceId);
			return true;
		},
		isSurfaceCloseBlocked: () => false,
	} as never);
</script>

<TerminalSurface {terminalId} {host} />
