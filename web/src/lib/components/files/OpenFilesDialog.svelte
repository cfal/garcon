<script lang="ts">
	import { tick } from 'svelte';
	import FileCode from '@lucide/svelte/icons/file-code';
	import Image from '@lucide/svelte/icons/image';
	import FileText from '@lucide/svelte/icons/file-text';
	import LocateFixed from '@lucide/svelte/icons/locate-fixed';
	import X from '@lucide/svelte/icons/x';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { getFileSessions, getWorkspaceCoordinator } from '$lib/context';
	import { fileSurfaceId } from '$lib/workspace/surface-types.js';
	import * as m from '$lib/paraglide/messages.js';
	import CopyFilePathButton from './CopyFilePathButton.svelte';

	const files = getFileSessions();
	const workspace = getWorkspaceCoordinator();

	function placement(sessionId: string): string {
		const surfaceId = fileSurfaceId(sessionId);
		const snapshot = workspace.layout.snapshot;
		if (snapshot.dialogFileSurfaceId === surfaceId) return m.file_session_placement_dialog();
		if (snapshot.main.order.includes(surfaceId)) return m.file_session_placement_main();
		if (snapshot.sidebar.order.includes(surfaceId)) return m.file_session_placement_sidebar();
		if (snapshot.mobileOnlySurfaceIds.includes(surfaceId)) return m.file_session_placement_mobile();
		return m.file_session_placement_retained();
	}

	function iconKind(contentKind: 'text' | 'markdown' | 'image') {
		return contentKind === 'image' ? Image : contentKind === 'markdown' ? FileText : FileCode;
	}

	async function focusSession(sessionId: string): Promise<void> {
		files.hideOpenFiles();
		await tick();
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		await workspace.focusFileSession(sessionId);
	}
</script>

<Dialog.Root
	open={files.openFilesVisible}
	onOpenChange={(open) => {
		if (!open) files.hideOpenFiles();
	}}
>
	<Dialog.Content
		class="flex max-h-[min(82dvh,760px)] max-w-3xl flex-col overflow-hidden p-0"
		showCloseButton={false}
	>
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>{m.file_session_open_files()}</Dialog.Title>
			<Dialog.Description>{m.file_session_open_files_description()}</Dialog.Description>
		</Dialog.Header>
		<div class="min-h-0 flex-1 overflow-y-auto p-2">
			{#if files.all.length === 0}
				<div class="grid min-h-32 place-items-center text-sm text-muted-foreground">
					{m.file_session_no_open_files()}
				</div>
			{:else}
				<div class="divide-y divide-border">
					{#each files.all as session (session.id)}
						{@const Icon = iconKind(session.contentKind)}
						<div class="flex min-w-0 items-center gap-3 px-2 py-2.5">
							<Icon class="h-4 w-4 shrink-0 text-muted-foreground" />
							<div class="min-w-0 flex-1">
								<div class="flex min-w-0 items-center gap-1.5">
									<span class="truncate text-sm font-medium">{session.fileName}</span>
									<CopyFilePathButton path={session.relativePath} />
									{#if session.dirty}<span
											class="text-status-warning-foreground"
											aria-label={m.file_session_unsaved()}>*</span
										>{/if}
								</div>
								<p
									class="truncate text-xs text-muted-foreground"
									title={`${session.canonicalFileRootPath}/${session.relativePath}`}
								>
									{session.relativePath} · {placement(session.id)}
								</p>
							</div>
							<Button
								variant="ghost"
								size="icon-sm"
								onclick={() => void focusSession(session.id)}
								aria-label={m.file_session_focus()}
								title={m.file_session_focus()}
							>
								<LocateFixed class="h-4 w-4" />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								onclick={() => void workspace.closeSurface(fileSurfaceId(session.id))}
								disabled={workspace.isSurfaceCloseBlocked(fileSurfaceId(session.id))}
								aria-label={m.file_session_close()}
								title={m.file_session_close()}
							>
								<X class="h-4 w-4" />
							</Button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
		<Dialog.Footer class="border-t border-border px-4 py-3">
			<Button variant="outline" onclick={() => files.hideOpenFiles()}
				>{m.file_session_done()}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
