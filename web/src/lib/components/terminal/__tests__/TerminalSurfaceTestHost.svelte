<script lang="ts">
	import { onDestroy } from 'svelte';
	import { terminalSurfaceId, type WorkspaceWindowId } from '$lib/workspace/surface-types';
	import { setLocalSettings } from '$lib/context';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte';
	import { setSurfaceFrameBridge, SurfaceFrameBridge } from '$lib/workspace/surface-frame-context';
	import {
		createWorkspaceLayoutStore,
		reduceWorkspaceLayout,
	} from '$lib/workspace/workspace-layout.svelte.js';
	import type {
		TerminalSurfaceRegistryPort,
		TerminalSurfaceRuntimePort,
		TerminalSurfaceWorkspacePort,
	} from '../terminal-surface-ports.js';
	import type { TerminalClientSession } from '$lib/terminal/sessions/terminal-registry.svelte.js';
	import TerminalSurface from '../TerminalSurface.svelte';

	interface Props {
		host: WorkspaceWindowId | 'mobile';
		onClose?: (surfaceId: string) => void;
		onModifier?: (modifier: 'ctrl' | 'alt') => void;
		onToolbarKey?: (key: string) => void;
		onSwitch?: (currentTerminalId: string, nextTerminalId: string) => void;
		onCreateReplacing?: (currentTerminalId: string) => void;
		onTerminate?: (terminalId: string) => void;
		onFocus?: () => void;
		onFontSize?: (fontSize: number) => void;
		focusRequestToken?: number;
		createError?: Error | null;
		closeError?: Error | null;
	}

	let {
		host,
		onClose = () => undefined,
		onModifier = () => undefined,
		onToolbarKey = () => undefined,
		onSwitch = () => undefined,
		onCreateReplacing = () => undefined,
		onTerminate = () => undefined,
		onFocus = () => undefined,
		onFontSize = () => undefined,
		focusRequestToken = 0,
		createError = null,
		closeError = null,
	}: Props = $props();
	const terminalId = 'terminal-1';
	const localSettings = createLocalSettingsStore();
	const session: TerminalClientSession = {
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
		lastReceivedSequence: 0,
		replayTruncatedAt: null,
	};
	const secondSession = {
		...session,
		metadata: { ...session.metadata, terminalId: 'terminal-2', displaySequence: 2 },
	};
	const runtime: TerminalSurfaceRuntimePort = {
		inputControls: {
			ctrlMode: 'inactive',
			altMode: 'inactive',
			toggleModifier: (modifier: 'ctrl' | 'alt') => onModifier(modifier),
		},
		sendToolbarKey: (key: string) => onToolbarKey(key),
		attach: () => ({ lease: 1, ready: Promise.resolve() }),
		park: () => undefined,
		scheduleFit: () => undefined,
		focus: () => onFocus(),
		pasteFromClipboard: () => Promise.resolve(),
		applyFontSize: (fontSize: number) => onFontSize(fontSize),
	};
	const frameBridge = new SurfaceFrameBridge();
	const layout = createWorkspaceLayoutStore();
	layout.publish(
		layout.revision,
		reduceWorkspaceLayout(layout.snapshot, [
			{
				type: 'register-surface',
				surface: {
					id: terminalSurfaceId(terminalId),
					type: 'terminal',
					terminalId,
				},
				windowId: 'window-main',
			},
		]),
	);
	const terminals = {
		sessions: { [terminalId]: session, 'terminal-2': secondSession },
		orderedSessions: [session, secondSession],
		listStatus: 'ready',
		listError: null,
		ensureRuntime: () => runtime,
		reattach: () => undefined,
		list: () => Promise.resolve(),
	} satisfies TerminalSurfaceRegistryPort;
	const workspace = {
		layout,
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
			if (closeError) throw closeError;
			return true;
		},
		isSurfaceCloseBlocked: () => false,
	} satisfies TerminalSurfaceWorkspacePort;

	$effect(() => {
		if (focusRequestToken > 0) frameBridge.focusPrimary();
	});

	setSurfaceFrameBridge(() => frameBridge);
	setLocalSettings(localSettings);

	onDestroy(() => localSettings.destroy());
</script>

<TerminalSurface {terminalId} {host} {terminals} {workspace} />
