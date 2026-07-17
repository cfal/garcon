<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Minimize2 from '@lucide/svelte/icons/minimize-2';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import SurfaceErrorState from '$lib/components/workspace/SurfaceErrorState.svelte';
	import { lazyRenderer } from '$lib/utils/lazy-renderer.js';
	import OpenFilesDialog from './OpenFilesDialog.svelte';
	import {
		getAppShell,
		getFileSessions,
		getWorkspaceCoordinator,
		getSurfaceFrames,
	} from '$lib/context';
	import { surfaceFrame } from '$lib/workspace/surface-frame-action';
	import {
		SurfaceFrameBridge,
		setSurfaceFrameBridge,
	} from '$lib/workspace/surface-frame-context.js';
	import * as m from '$lib/paraglide/messages.js';
	import { shouldWaitForFileRenderer } from './file-renderer-frame.js';

	const files = getFileSessions();
	const appShell = getAppShell();
	const workspace = getWorkspaceCoordinator();
	const surfaceFrames = getSurfaceFrames();
	const frameBridge = new SurfaceFrameBridge();
	setSurfaceFrameBridge(() => frameBridge);
	let maximized = $state(false);
	const surfaceId = $derived(workspace.layout.snapshot.dialogFileSurfaceId);
	const descriptor = $derived(surfaceId ? workspace.layout.surface(surfaceId) : null);
	const session = $derived(
		descriptor?.type === 'file' ? files.get(descriptor.fileSessionId) : null,
	);
	const fileRenderer = lazyRenderer(() => import('./FileSurface.svelte'));
	let rendererRetryKey = $state(0);

	function retryFileSurface(): void {
		rendererRetryKey += 1;
	}
</script>

<Dialog.Root
	open={Boolean(session) && !appShell.isMobile}
	requestClose={() => {
		if (surfaceId && !appShell.isMobile) void workspace.closeSurface(surfaceId);
	}}
>
	<Dialog.Content
		showCloseButton={false}
		transientKind="file-dialog"
		class={maximized
			? 'flex h-dvh w-screen max-w-none flex-col gap-0 rounded-none border-0 p-0 sm:max-w-none'
			: 'flex h-[min(90dvh,1000px)] w-[min(96vw,1440px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none'}
	>
		{#if session && surfaceId}
			<div class="flex h-10 shrink-0 items-center justify-end gap-1 border-b border-border px-2">
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={() => void workspace.moveDialogFileToHost('main')}
					aria-label={m.file_session_move_main()}
					title={m.file_session_move_main()}
				>
					<PanelLeft class="h-4 w-4" />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={() => void workspace.moveDialogFileToHost('sidebar')}
					aria-label={m.file_session_move_sidebar()}
					title={m.file_session_move_sidebar()}
				>
					<PanelRight class="h-4 w-4" />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={() => (maximized = !maximized)}
					aria-label={maximized
						? m.file_session_restore_dialog()
						: m.file_session_maximize_dialog()}
					title={maximized ? m.file_session_restore_dialog() : m.file_session_maximize_dialog()}
				>
					{#if maximized}<Minimize2 class="h-4 w-4" />{:else}<Maximize2 class="h-4 w-4" />{/if}
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={() => void workspace.closeSurface(surfaceId)}
					disabled={workspace.isSurfaceCloseBlocked(surfaceId)}
					aria-label={m.file_session_close()}
					title={m.file_session_close()}
				>
					<X class="h-4 w-4" />
				</Button>
			</div>
			<div
				class="min-h-0 flex-1"
				use:surfaceFrame={{
					registry: surfaceFrames,
					surfaceId,
					host: 'dialog',
					version: workspace.frameVersion(surfaceId),
					renderer: frameBridge,
					waitForRenderer: shouldWaitForFileRenderer(session),
				}}
			>
				{#if workspace.attachmentErrors[surfaceId]}
					<SurfaceErrorState
						message={workspace.attachmentErrors[surfaceId] || m.workspace_surface_attach_failed()}
						onRetry={() => void workspace.retryPresentation(surfaceId, 'dialog')}
					/>
				{:else}
					<svelte:boundary>
						{#key rendererRetryKey}
							{#await fileRenderer()}
								<div class="grid h-full place-items-center text-sm text-muted-foreground">
									{m.file_session_loading()}
								</div>
							{:then FileSurface}
								<FileSurface {session} presentation="dialog" />
							{:catch error}
								<SurfaceErrorState
									message={error instanceof Error
										? error.message
										: m.workspace_surface_render_failed()}
									onRetry={retryFileSurface}
								/>
							{/await}
						{/key}
						{#snippet failed(error, reset)}
							<SurfaceErrorState
								message={error instanceof Error
									? error.message
									: m.workspace_surface_render_failed()}
								onRetry={reset}
							/>
						{/snippet}
					</svelte:boundary>
				{/if}
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={Boolean(files.guardRequest)} requestClose={() => files.resolveGuard('cancel')}>
	<Dialog.Content class="sm:max-w-md" showCloseButton={false}>
		<Dialog.Header>
			<Dialog.Title>{m.file_session_unsaved_title()}</Dialog.Title>
			<Dialog.Description>
				{m.file_session_unsaved_description({ fileName: files.guardRequest?.fileName ?? '' })}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="ghost" onclick={() => files.resolveGuard('cancel')}
				>{m.file_session_cancel()}</Button
			>
			<Button variant="destructive" onclick={() => files.resolveGuard('discard')}
				>{m.file_session_discard()}</Button
			>
			<Button onclick={() => files.resolveGuard('save')}>{m.file_session_save()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root
	open={Boolean(files.thresholdRequest) && (!files.openFilesVisible || appShell.isMobile)}
	requestClose={() => files.resolveThreshold('cancel')}
>
	<Dialog.Content class="sm:max-w-md" showCloseButton={false}>
		<Dialog.Header>
			<Dialog.Title>{m.file_session_many_open_title()}</Dialog.Title>
			<Dialog.Description>
				{m.file_session_many_open_description()}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="ghost" onclick={() => files.resolveThreshold('cancel')}
				>{m.file_session_cancel()}</Button
			>
			{#if !appShell.isMobile}
				<Button variant="outline" onclick={() => files.resolveThreshold('review')}
					>{m.file_session_review_open()}</Button
				>
			{/if}
			<Button onclick={() => files.resolveThreshold('open')}>{m.file_session_open_anyway()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

{#if !appShell.isMobile}
	<OpenFilesDialog />
{/if}
