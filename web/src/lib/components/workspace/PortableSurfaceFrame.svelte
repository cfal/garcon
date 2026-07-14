<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import X from '@lucide/svelte/icons/x';
	import { getFileSessions, getSurfaceFrames, getWorkspaceCoordinator } from '$lib/context';
	import { shouldWaitForFileRenderer } from '$lib/components/files/file-renderer-frame.js';
	import * as m from '$lib/paraglide/messages.js';
	import { surfaceFrame } from '$lib/workspace/surface-frame-action.js';
	import type { SurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
	import type { HostId, SurfaceDescriptor } from '$lib/workspace/surface-types.js';
	import PortableSurfaceContent from './PortableSurfaceContent.svelte';

	let {
		surface,
		presentation,
		visible,
		mainInert = false,
		style,
		onSendToChat,
		frameBridge,
	}: {
		surface: SurfaceDescriptor;
		presentation: HostId | 'mobile';
		visible: boolean;
		mainInert?: boolean;
		style: string;
		onSendToChat: (message: string) => Promise<boolean>;
		frameBridge: SurfaceFrameBridge;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const fileSessions = getFileSessions();
	const surfaceFrames = getSurfaceFrames();
	const fileSession = $derived(
		surface.type === 'file' ? fileSessions.get(surface.fileSessionId) : null,
	);
</script>

<div
	data-workspace-surface-id={surface.id}
	onfocusin={() => workspace.noteSurfaceFocus(surface.id)}
	onpointerdown={() => workspace.noteSurfaceFocus(surface.id)}
	id={`${presentation}-panel-${surface.id}`}
	role="tabpanel"
	tabindex="-1"
	aria-labelledby={presentation === 'main' || presentation === 'sidebar'
		? `${presentation}-tab-${surface.id}`
		: undefined}
	inert={!visible || (presentation === 'main' && mainInert)}
	aria-hidden={!visible}
	class="absolute z-20 min-h-0 min-w-0 overflow-hidden bg-background"
	class:invisible={!visible}
	class:pointer-events-none={!visible}
	{style}
	use:surfaceFrame={{
		registry: surfaceFrames,
		surfaceId: surface.id,
		host: presentation,
		version: workspace.frameVersion(surface.id),
		renderer: frameBridge,
		waitForRenderer:
			surface.type === 'terminal' ||
			(surface.type === 'file' && shouldWaitForFileRenderer(fileSession)),
	}}
>
	{#if workspace.attachmentErrors[surface.id]}
		<div class="grid h-full place-items-center px-6 text-center">
			<div class="max-w-sm text-sm text-status-error-foreground">
				<p>{workspace.attachmentErrors[surface.id] || m.workspace_surface_attach_failed()}</p>
				<div class="mt-3 flex items-center justify-center gap-2">
					<button
						type="button"
						class="rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent"
						onclick={() => void workspace.retryPresentation(surface.id, presentation)}
						>{m.common_retry()}</button
					>
					<button
						type="button"
						class="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent disabled:opacity-50"
						onclick={() => void workspace.closeSurface(surface.id)}
						disabled={workspace.isSurfaceCloseBlocked(surface.id)}
					>
						<X class="h-3.5 w-3.5" />
						{m.workspace_close_view()}
					</button>
				</div>
			</div>
		</div>
	{:else if presentation === 'mobile' && (surface.type === 'file' || (surface.type === 'singleton' && surface.kind === 'commit'))}
		<div class="flex h-full min-h-0 flex-col">
			<div class="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
				<button
					type="button"
					class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					onclick={() => void workspace.mobileBack()}
					aria-label={m.workspace_back()}
					title={m.workspace_back()}
				>
					<ArrowLeft class="h-4 w-4" />
				</button>
				<button
					type="button"
					class="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					onclick={() => void workspace.closeSurface(surface.id)}
					disabled={workspace.isSurfaceCloseBlocked(surface.id)}
					aria-label={m.workspace_close_view()}
					title={m.workspace_close_view()}
				>
					<X class="h-4 w-4" />
				</button>
			</div>
			<div class="min-h-0 flex-1 overflow-hidden">
				<PortableSurfaceContent {surface} {presentation} {visible} {onSendToChat} {frameBridge} />
			</div>
		</div>
	{:else}
		<PortableSurfaceContent {surface} {presentation} {visible} {onSendToChat} {frameBridge} />
	{/if}
</div>
