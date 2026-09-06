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
		terminalId?: string;
		onClose?: (surfaceId: string) => void;
		onModifier?: (modifier: 'ctrl' | 'alt') => void;
		onToolbarKey?: (key: string) => void;
		onSwitch?: (currentTerminalId: string, nextTerminalId: string) => void;
		onCreateReplacing?: (currentTerminalId: string) => void;
		onTerminate?: (terminalId: string) => void;
		onRename?: (terminalId: string, title: string | null) => void;
		onFocus?: () => void;
		onFontSize?: (fontSize: number) => void;
		onReattach?: (terminalId: string) => void;
		focusRequestToken?: number;
		runtimeDelay?: Promise<void>;
		runtimeDelays?: Readonly<Record<string, Promise<void>>>;
		runtimeError?: string | null;
		createError?: Error | null;
		closeError?: Error | null;
	}

	let {
		host,
		terminalId = 'terminal-1',
		onClose = () => undefined,
		onModifier = () => undefined,
		onToolbarKey = () => undefined,
		onSwitch = () => undefined,
		onCreateReplacing = () => undefined,
		onTerminate = () => undefined,
		onRename = () => undefined,
		onFocus = () => undefined,
		onFontSize = () => undefined,
		onReattach = () => undefined,
		focusRequestToken = 0,
		runtimeDelay,
		runtimeDelays,
		runtimeError = null,
		createError = null,
		closeError = null,
	}: Props = $props();
	const localSettings = createLocalSettingsStore();
	function sessionFor(
		selectedTerminalId: string,
		displaySequence: number,
		title: string | null,
	): TerminalClientSession {
		return {
			metadata: {
				terminalId: selectedTerminalId,
				displaySequence,
				title,
				initialWorkingDirectory: '/workspace/project',
				processStatus: 'running',
				attachmentStatus: 'attached',
				createdAt: '2026-07-13T00:00:00.000Z',
				exitCode: null,
				latestOutputSequence: 0,
			},
			attachmentState: 'attached',
			runtimeState: runtimeError ? 'failed' : 'ready',
			runtimeError,
			lastReceivedSequence: 0,
			replayTruncatedAt: null,
		};
	}
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
					id: terminalSurfaceId('terminal-1'),
					type: 'terminal',
					terminalId: 'terminal-1',
				},
				windowId: 'window-main',
			},
		]),
	);
	const terminals = {
		get sessions() {
			return {
				'terminal-1': sessionFor('terminal-1', 1, null),
				'terminal-2': sessionFor('terminal-2', 2, 'Build logs'),
			};
		},
		get orderedSessions() {
			return Object.values(this.sessions);
		},
		listStatus: 'ready',
		listError: null,
		ensureRuntime: async (selectedTerminalId: string) => {
			await (runtimeDelays?.[selectedTerminalId] ?? runtimeDelay);
			return runtime;
		},
		reattach: (selectedTerminalId: string) => onReattach(selectedTerminalId),
		rename: async (selectedTerminalId: string, title: string | null) => {
			onRename(selectedTerminalId, title);
		},
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
