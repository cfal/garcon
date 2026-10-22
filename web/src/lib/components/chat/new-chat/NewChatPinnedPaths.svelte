<script lang="ts">
	import { tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { getExecutors, getRemoteSettings } from '$lib/context';
	import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte';
	import { executorStatus } from '$lib/executors/executors-store.svelte';
	import { NewChatPinnedPathsController } from '$lib/chat/new-chat/new-chat-pinned-paths-controller';
	import ProjectPinnedPathList from '$lib/components/project-paths/ProjectPinnedPathList.svelte';
	import * as Popover from '$lib/components/ui/popover';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as m from '$lib/paraglide/messages.js';

	let { form }: { form: NewChatFormState } = $props();
	const id = $props.id();
	const executors = getExecutors();
	const pins = new NewChatPinnedPathsController(() => form, executors, getRemoteSettings());
	const mobile = new MediaQuery('(max-width: 639px)');
	let open = $state(false);
	let trigger = $state<HTMLElement | null>(null);
	let content = $state<HTMLElement | null>(null);
	let restoreOnClose = true;
	// Keeps the focus return target mounted after selection or live pin removal.
	let pickerVisited = $state(false);
	const groups = $derived(pins.groups);
	const current = $derived(groups.find((group) => group.executorId === form.executorId));
	const currentExecutor = $derived(executors.get(form.executorId));
	const currentReady = $derived(executors.isReady(form.executorId));
	const otherGroups = $derived(groups.filter((group) => group.executorId !== form.executorId));
	const triggerClass =
		'min-h-7 shrink-0 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring any-pointer-coarse:min-h-11';

	function select(executorId: string, path: string): void {
		if (pins.select(executorId, path)) open = false;
	}

	async function restoreFocus(event: Event): Promise<void> {
		event.preventDefault();
		if (!restoreOnClose) return;
		await tick();
		// Restores focus after the enclosing form's reactive autofocus has settled.
		requestAnimationFrame(() => {
			if (!open && restoreOnClose) trigger?.focus({ preventScroll: true });
		});
	}

	async function focusPicker(event: Event): Promise<void> {
		restoreOnClose = true;
		event.preventDefault();
		await tick();
		requestAnimationFrame(() => {
			if (!open || !content || content.contains(content.ownerDocument.activeElement)) return;
			const firstButton = content.querySelector<HTMLButtonElement>('button:not([disabled])');
			(firstButton ?? content).focus({ preventScroll: true });
		});
	}
</script>

{#snippet pickerContent()}
	<div
		class="max-h-[min(24rem,55dvh)] space-y-4 overflow-y-auto overscroll-contain p-1"
		data-executor-pins-picker
	>
		{#each otherGroups as group (group.executorId)}
			{@const executor = executors.get(group.executorId)}
			{@const label = executor?.label ?? group.executorId}
			{@const ready = executors.isReady(group.executorId)}
			<div role="group" aria-label={label} class="min-w-0 space-y-2">
				<p class="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
					<span class="min-w-0 break-all font-medium text-foreground">{label}</span>
					{#if !ready}
						<span id={id + '-' + group.executorId + '-status'}
							>{executor
								? executorStatus(executor)
								: m.chat_new_chat_pinned_paths_unavailable_executor()}</span
						>
					{/if}
				</p>
				<ProjectPinnedPathList
					pinnedProjectPaths={group.paths}
					selectedPath=""
					labelPrefix={label}
					statusId={!ready ? id + '-' + group.executorId + '-status' : undefined}
					disabled={!ready || form.isUpdatingPinnedPath}
					onSelect={(path) => select(group.executorId, path)}
				/>
			</div>
		{:else}
			<p class="text-sm text-muted-foreground">{m.chat_new_chat_pinned_paths_no_other_pins()}</p>
		{/each}
	</div>
{/snippet}

<section aria-label={m.chat_new_chat_pinned_paths()} class="min-w-0">
	<div class="flex min-w-0 flex-wrap items-center gap-2">
		{#if current}
			{#if !currentReady}
				<p id={id + '-current-status'} class="w-full text-xs text-muted-foreground">
					{currentExecutor?.label ?? form.executorId}: {currentExecutor
						? executorStatus(currentExecutor)
						: m.chat_new_chat_pinned_paths_unavailable_executor()}
				</p>
			{/if}
			<ProjectPinnedPathList
				class="contents"
				pinnedProjectPaths={current.paths}
				selectedPath={form.projectPath}
				statusId={!currentReady ? id + '-current-status' : undefined}
				disabled={!currentReady || form.isUpdatingPinnedPath}
				onSelect={(path) => pins.select(form.executorId, path)}
			/>
		{:else if otherGroups.length === 0}
			<p
				class="w-full rounded-md bg-muted/30 px-2.5 py-1 text-center text-xs text-muted-foreground"
			>
				{m.chat_new_chat_star_bookmark()}
			</p>
		{/if}
		{#if otherGroups.length > 0 || pickerVisited}
			{#if mobile.current}
				<Dialog.Root bind:open>
					<Dialog.Trigger
						bind:ref={trigger}
						class={triggerClass}
						onfocus={() => {
							pickerVisited = true;
						}}>{m.chat_new_chat_pinned_paths_other_executors()}</Dialog.Trigger
					>
					<Dialog.Content
						bind:ref={content}
						onOpenAutoFocus={focusPicker}
						onCloseAutoFocus={restoreFocus}
						class="top-auto bottom-0 left-0 max-w-full translate-x-0 translate-y-0 gap-3 rounded-b-none rounded-t-2xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
						showCloseButton={false}
					>
						<div class="flex items-center justify-between gap-3">
							<Dialog.Title class="text-sm font-medium"
								>{m.chat_new_chat_pinned_paths_other_executors()}</Dialog.Title
							>
							<Dialog.Close
								class="min-h-11 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>{m.common_close()}</Dialog.Close
							>
						</div>
						{@render pickerContent()}
					</Dialog.Content>
				</Dialog.Root>
			{:else}
				<Popover.Root bind:open>
					<Popover.Trigger
						bind:ref={trigger}
						class={triggerClass}
						onfocus={() => {
							pickerVisited = true;
						}}>{m.chat_new_chat_pinned_paths_other_executors()}</Popover.Trigger
					>
					<Popover.Content
						onInteractOutside={() => { restoreOnClose = false; }}
						bind:ref={content}
						onOpenAutoFocus={focusPicker}
						getFocusReturnTarget={() => trigger}
						onCloseAutoFocus={restoreFocus}
						align="start"
						collisionPadding={8}
						aria-label={m.chat_new_chat_pinned_paths_other_executors()}
						class="w-[min(26rem,calc(100vw-1rem))] max-h-(--bits-popover-content-available-height) overflow-y-auto p-3"
					>
						{@render pickerContent()}
					</Popover.Content>
				</Popover.Root>
			{/if}
		{/if}
	</div>
</section>
