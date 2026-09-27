<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { untrack } from 'svelte';
	import {
		getExecutors,
		getModelCatalog,
		getLocalSettings,
		getAppShell,
		getChatSessions,
	} from '$lib/context';
	import { effectiveExecutorId } from '$shared/executors';
	import ComposerModelSelector from '$lib/components/model-selector/ComposerModelSelector.svelte';
	import DirectoryBrowser from './DirectoryBrowser.svelte';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import { isDirectAgentId, nonDirectAgentIds } from '$lib/agents/direct-agents';
	import type { ExecutorHandoffProjectState } from '$lib/chat/conversation/executor-handoff-project.svelte.js';
	import type { ModelSelectorChange } from '$lib/components/model-selector/model-selector-types';
	import * as m from '$lib/paraglide/messages.js';
	let { handoff }: { handoff: ExecutorHandoffProjectState } = $props();
	const executors = getExecutors();
	const shell = getAppShell();
	const rootCatalog = getModelCatalog();
	const localSettings = getLocalSettings();
	let showBrowser = $state(false);
	const sessions = getChatSessions();
	const executorId = $derived(handoff.target?.executorId ?? 'local');
	// A destination on the chat's own executor only replaces an unavailable folder.
	const choosingFolder = $derived(
		handoff.target !== null &&
			effectiveExecutorId(sessions.byId[handoff.target.chatId]?.executorId) === executorId,
	);
	const catalog = $derived(rootCatalog.forExecutor(executorId));
	const basePath = $derived(executors.get(executorId)?.projectBasePath ?? '');
	const agents = $derived(
		localSettings.allowDirectChats || isDirectAgentId(handoff.selection?.agentId ?? '')
			? catalog.getSelectableAgents()
			: nonDirectAgentIds(catalog.getSelectableAgents()),
	);
	$effect(() => {
		void handoff.target;
		showBrowser = false;
	});
	$effect(() => {
		if (!handoff.target || !executors.isReady(executorId)) return;
		void catalog.version;
		untrack(() => {
			void catalog.refreshIfStale();
		});
	});

	function handleModelChange(selection: ModelSelectorChange): void {
		if (selection.executorId === executorId) handoff.selection = selection;
	}

	function handleSubmit(event: SubmitEvent): void {
		event.preventDefault();
		void handoff.confirm();
	}
</script>

<Dialog.Root
	open={handoff.target !== null}
	onOpenChange={(open) => {
		if (!open) handoff.cancel();
	}}
>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>
				{choosingFolder
					? m.chat_executor_handoff_folder_title()
					: m.chat_executor_handoff_title({ label: executors.label(handoff.target?.executorId) })}
			</Dialog.Title>
			<Dialog.Description>{m.chat_executor_handoff_description()}</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={handleSubmit}>
			<div class="relative space-y-1">
				<label for="handoff-path" class="text-sm">{m.chat_executor_handoff_project_label()}</label>
				<div class="flex gap-2">
					<input
						id="handoff-path"
						class="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-base pointer-fine:text-sm"
						bind:value={handoff.projectPath}
						required
						disabled={handoff.checking}
					/>
					<Button
						type="button"
						variant="outline"
						size="icon"
						title={m.chat_executor_handoff_browse()}
						aria-label={m.chat_executor_handoff_browse()}
						disabled={handoff.checking || !executors.filesAvailable(executorId)}
						onclick={() => (showBrowser = !showBrowser)}
					>
						<FolderOpen class="size-4" />
					</Button>
				</div>
				{#if showBrowser && executors.filesAvailable(executorId)}
					<DirectoryBrowser
						{executorId}
						executorContextKey={executors.pathContextKey(executorId)}
						{basePath}
						isMobile={shell.isMobile}
						currentPath={handoff.projectPath || basePath}
						onSelect={(path) => {
							handoff.projectPath = path;
						}}
						onClose={() => (showBrowser = false)}
					/>
				{/if}
			</div>
			{#if handoff.selection}
				<ComposerModelSelector
					value={{ executorId, ...handoff.selection }}
					mode={{ agent: 'select', source: 'select', surface: 'composer' }}
					getSelectableAgentIds={() => agents}
					disabled={handoff.checking}
					onChange={handleModelChange}
				/>
			{/if}
			{#if !executors.isReady(executorId)}
				<p role="status" class="text-sm text-destructive">
					{m.chat_executor_handoff_executor_unavailable()}
				</p>
			{:else if catalog.error}
				<p role="alert" class="text-sm text-destructive">
					{catalog.error}
					<button type="button" class="underline" onclick={() => void catalog.forceRefresh()}>
						{m.common_retry()}
					</button>
				</p>
			{:else if !catalog.isValidated}
				<p role="status" class="text-sm text-muted-foreground">{m.chat_composer_loading_models()}</p>
			{:else if !handoff.selectionAvailable}
				<p role="status" class="text-sm text-destructive" data-handoff-selection-unavailable>
					{m.chat_executor_handoff_selection_unavailable({ label: executors.label(executorId) })}
				</p>
			{/if}
			{#if handoff.error}
				<p role="alert" class="text-sm text-destructive">{handoff.error}</p>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => handoff.cancel()}>
					{m.common_cancel()}
				</Button>
				<Button type="submit" disabled={!handoff.canConfirm}>
					{#if handoff.checking}
						{m.chat_executor_handoff_checking()}
					{:else if choosingFolder}
						{m.chat_executor_handoff_folder_confirm()}
					{:else}
						{m.chat_executor_handoff_confirm()}
					{/if}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
