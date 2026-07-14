<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import Clipboard from '@lucide/svelte/icons/clipboard';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Square from '@lucide/svelte/icons/square';
	import X from '@lucide/svelte/icons/x';
	import { getTerminalRegistry, getWorkspaceCoordinator } from '$lib/context';
	import { terminalSurfaceId, type HostId } from '$lib/workspace/surface-types';
	import type { TerminalToolbarKey } from './terminal-input-controls.svelte.js';
	import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';
	import * as m from '$lib/paraglide/messages.js';
	import { getSurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
	import { ApiError } from '$lib/api/client.js';
	import ResponsiveSurfaceActions, {
		type ResponsiveSurfaceAction,
	} from '$lib/components/shared/ResponsiveSurfaceActions.svelte';

	let {
		terminalId,
		host,
		visible = true,
	}: {
		terminalId: string;
		host: HostId | 'mobile';
		visible?: boolean;
	} = $props();
	const terminals = getTerminalRegistry();
	const workspace = getWorkspaceCoordinator();
	const frame = getSurfaceFrameBridge();
	let terminalHost = $state<HTMLDivElement | null>(null);
	let sessionPicker = $state<HTMLSelectElement | null>(null);
	let lease: number | null = null;
	let observer: ResizeObserver | null = null;
	let actionError = $state<string | null>(null);
	let hasCoarsePointer = $state(false);
	const session = $derived(terminals.sessions[terminalId] ?? null);
	const runtime = $derived(session ? terminals.runtime(terminalId) : null);
	const showInputControls = $derived(host === 'mobile' || hasCoarsePointer);
	const toolbarActions = $derived.by<ResponsiveSurfaceAction[]>(() => {
		const actions: ResponsiveSurfaceAction[] = [
			{
				id: 'new',
				label: m.terminal_new(),
				icon: Plus,
				onclick: () => void createTerminal(),
				disabled:
					terminals.orderedSessions.length >= TERMINAL_SESSION_LIMIT ||
					terminals.listStatus !== 'ready',
				priority: 0,
			},
			{
				id: 'terminate',
				label: m.terminal_terminate(),
				icon: Square,
				onclick: () => void terminateTerminal(),
				disabled: !session || workspace.isSurfaceCloseBlocked(terminalSurfaceId(terminalId)),
				priority: 1,
				variant: 'destructive',
			},
		];
		if (
			session?.attachmentState === 'taken-over' ||
			session?.attachmentState === 'unavailable' ||
			session?.attachmentState === 'detached'
		) {
			actions.push({
				id: 'reattach',
				label: m.terminal_reattach(),
				icon: RefreshCw,
				onclick: () => terminals.reattach(terminalId),
				priority: 2,
			});
		}
		actions.push(
			{
				id: 'paste',
				label: m.terminal_paste(),
				icon: Clipboard,
				onclick: () => void runtime?.pasteFromClipboard(),
				disabled: !runtime,
				priority: 3,
			},
		);
		return actions;
	});
	const toolbarKeys: Array<{ key: TerminalToolbarKey; label: string }> = [
		{ key: 'escape', label: m.terminal_key_escape() },
		{ key: 'tab', label: m.terminal_key_tab() },
		{ key: 'up', label: m.terminal_key_up() },
		{ key: 'down', label: m.terminal_key_down() },
		{ key: 'left', label: m.terminal_key_left() },
		{ key: 'right', label: m.terminal_key_right() },
	];

	function attachmentLabel(
		attachmentState: NonNullable<typeof session>['attachmentState'],
	): string {
		return {
			connecting: m.terminal_attachment_connecting(),
			attached: m.terminal_attachment_attached(),
			detached: m.terminal_attachment_detached(),
			'taken-over': m.terminal_attachment_taken_over(),
			unavailable: m.terminal_attachment_unavailable(),
		}[attachmentState];
	}

	function placementLabel(itemTerminalId: string): string | null {
		const surfaceId = terminalSurfaceId(itemTerminalId);
		const snapshot = workspace.layout.snapshot;
		if (snapshot.main.order.includes(surfaceId)) return m.workspace_main_view();
		if (snapshot.sidebar.order.includes(surfaceId)) return m.workspace_sidebar_view();
		return null;
	}

	$effect(() => {
		const media = window.matchMedia('(pointer: coarse)');
		const update = () => (hasCoarsePointer = media.matches);
		update();
		media.addEventListener('change', update);
		return () => media.removeEventListener('change', update);
	});

	$effect(() => {
		const retainedRuntime = runtime;
		const element = terminalHost;
		if (!element || !retainedRuntime) return;
		const detach = () => {
			observer?.disconnect();
			observer = null;
			if (lease !== null) retainedRuntime.park(lease);
			lease = null;
		};
		return frame.provideRenderer({
			attach: () => {
				detach();
				lease = retainedRuntime.attach(element);
				observer = new ResizeObserver(() => retainedRuntime.scheduleFit());
				observer.observe(element);
			},
			detach,
			focusPrimary: () => retainedRuntime.focus(),
		});
	});

	function selectTerminal(value: string): void {
		if (!value) return;
		void workspace.switchTerminalSurface(terminalId, value);
	}

	async function createTerminal(): Promise<void> {
		actionError = null;
		try {
			await workspace.createTerminalReplacing(terminalId, `terminal-surface:${terminalId}:${host}`);
		} catch (error) {
			actionError = error instanceof Error ? error.message : m.terminal_create_failed();
			if (error instanceof ApiError && error.errorCode === 'terminal-limit') {
				queueMicrotask(() => sessionPicker?.focus());
			}
		}
	}

	async function terminateTerminal(): Promise<void> {
		actionError = null;
		try {
			await workspace.terminateTerminalSession(terminalId);
		} catch (error) {
			actionError = error instanceof Error ? error.message : m.terminal_unavailable();
		}
	}
</script>

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
	<div
		class="surface-toolbar flex h-10 shrink-0 items-center gap-2 border-b border-border px-2"
		style="container-name: surface-toolbar; container-type: inline-size;"
	>
		<div class="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
			<select
				bind:this={sessionPicker}
				class="min-w-24 max-w-56 truncate rounded-md border border-border bg-background px-2 py-1 text-xs"
				value={terminalId}
				onchange={(event) => selectTerminal(event.currentTarget.value)}
				aria-label={m.terminal_session()}
			>
				{#each terminals.orderedSessions as item (item.metadata.terminalId)}
					{@const placement = placementLabel(item.metadata.terminalId)}
					<option value={item.metadata.terminalId}>
						{m.terminal_session_status({
							number: item.metadata.displaySequence,
							status: item.metadata.processStatus,
						})}{placement ? ` - ${placement}` : ''}
					</option>
				{/each}
			</select>
			{#if session}
				<span
					class="min-w-0 flex-1 truncate text-xs text-muted-foreground"
					title={m.terminal_initial_working_directory({
						path: session.metadata.initialWorkingDirectory,
					})}
				>
					{m.terminal_initial_working_directory({
						path: session.metadata.initialWorkingDirectory,
					})}
				</span>
				<span class="shrink-0 text-[11px] text-muted-foreground"
					>{attachmentLabel(session.attachmentState)}</span
				>
			{/if}
		</div>
		<ResponsiveSurfaceActions
			actions={toolbarActions}
			menuLabel={m.workspace_surface_actions()}
			class="max-w-28"
		/>
		{#if host === 'mobile'}
			<button
				type="button"
				class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				onclick={() => void workspace.closeSurface(terminalSurfaceId(terminalId))}
				disabled={workspace.isSurfaceCloseBlocked(terminalSurfaceId(terminalId))}
				aria-label={m.terminal_close_tab()}
				title={m.terminal_close_tab()}
			>
				<X class="h-4 w-4" />
			</button>
		{/if}
	</div>
	{#if actionError}
		<div
			class="border-b border-status-error-border bg-status-error px-3 py-1.5 text-xs text-status-error-foreground"
		>
			{actionError}
		</div>
	{/if}
	{#if !session}
		<div class="grid min-h-0 flex-1 place-items-center p-6 text-center">
			<div class="max-w-sm text-sm text-muted-foreground">
				<p>{terminals.listError ?? m.terminal_unavailable()}</p>
				<button
					class="mt-3 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent hover:text-foreground"
					onclick={() => void terminals.list()}>{m.common_retry()}</button
				>
			</div>
		</div>
	{:else}
		{#if session.replayTruncatedAt}
			<div class="border-b border-border bg-muted px-3 py-1 text-xs text-muted-foreground">
				{m.terminal_earlier_output_unavailable()}
			</div>
		{/if}
		<div bind:this={terminalHost} class="min-h-0 flex-1 bg-background"></div>
		{#if runtime && showInputControls}
			<div class="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border p-1">
				<button
					type="button"
					class="h-8 rounded-md border border-border px-2 text-xs"
					onclick={() => runtime.inputControls.toggleModifier('ctrl')}
					aria-pressed={runtime.inputControls.ctrlMode !== 'inactive'}
					>{m.terminal_key_control()}</button
				>
				<button
					type="button"
					class="h-8 rounded-md border border-border px-2 text-xs"
					onclick={() => runtime.inputControls.toggleModifier('alt')}
					aria-pressed={runtime.inputControls.altMode !== 'inactive'}>{m.terminal_key_alt()}</button
				>
				{#each toolbarKeys as item (item.key)}
					<button
						type="button"
						class="h-8 min-w-8 rounded-md border border-border px-2 text-xs"
						onclick={() => runtime.sendToolbarKey(item.key)}
						aria-label={item.label}>{item.label}</button
					>
				{/each}
			</div>
		{/if}
	{/if}
</div>
