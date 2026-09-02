<script lang="ts">
	import ComposerBottomBar from '$lib/components/chat/ComposerBottomBar.svelte';
	import AgentSettingsControls from '$lib/components/chat/AgentSettingsControls.svelte';
	import ChatTagEditor from '$lib/components/chat/ChatTagEditor.svelte';
	import ChatTagToggleButton from '$lib/components/chat/ChatTagToggleButton.svelte';
	import DirectoryBrowser from '$lib/components/chat/DirectoryBrowser.svelte';
	import ProjectPinnedPathList from '$lib/components/chat/ProjectPinnedPathList.svelte';
	import ProjectPinnedPathToggleButton from '$lib/components/chat/ProjectPinnedPathToggleButton.svelte';
	import GitWorktreePickerModal from '$lib/components/git/GitWorktreePickerModal.svelte';
	import ComposerModelSelector from '$lib/components/model-selector/ComposerModelSelector.svelte';
	import ScheduledPromptField from './ScheduledPromptField.svelte';
	import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte.js';
	import {
		buildPermissionOptions,
		buildThinkingOptions,
	} from '$lib/chat/composer/composer-controls.js';
	import { buildModelSelectorRecents } from '$lib/components/model-selector/model-selector-recents';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
	} from '$lib/components/model-selector/model-selector-types';
	import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
	import type { SessionAgentId } from '$lib/types/app';
	import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
	import Check from '@lucide/svelte/icons/check';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		startup: NewChatFormState;
		modelCatalog: ModelCatalogStore;
		remoteSettings: RemoteSettingsStore;
		selectableAgentIds: readonly SessionAgentId[];
		prompt: string;
		promptError: string | null;
		knownTags: string[];
		isMobile: boolean;
		onPromptChange: (value: string) => void;
		onPromptKeydown: (event: KeyboardEvent) => void;
	}

	let {
		startup,
		modelCatalog,
		remoteSettings,
		selectableAgentIds,
		prompt,
		promptError,
		knownTags,
		isMobile,
		onPromptChange,
		onPromptKeydown,
	}: Props = $props();
	let textarea: HTMLTextAreaElement | null = $state(null);

	const permissionOptions = $derived(buildPermissionOptions(startup.permissionModes));
	const thinkingOptions = $derived(buildThinkingOptions(startup.thinkingModes, startup.modelValue));
	const modelSelectorMode: ModelSelectorMode = {
		agent: 'select',
		source: 'select',
		surface: 'composer',
	};
	const modelSelectorValue = $derived({
		agentId: startup.agentId,
		model: startup.modelValue,
		...(startup.modelSelectionTarget ?? {}),
	});
	const recentSelectorOptions = $derived.by(() =>
		buildModelSelectorRecents(modelCatalog, remoteSettings.snapshot?.recentAgentSettings ?? []),
	);
	const preferRecentsOnOpen = $derived(recentSelectorOptions.length > 1);

	function handlePathKeydown(event: KeyboardEvent): void {
		if (event.key === 'Tab') {
			event.preventDefault();
			void startup.handleTabCompletion();
			return;
		}
		if (event.key !== 'Enter') return;
		event.preventDefault();
		startup.showBrowser = false;
		textarea?.focus();
	}

	function handleModelChange(next: ModelSelectorChange): void {
		startup.selectAgent(next.agentId);
		startup.selectModel(next.modelValue, next);
	}
</script>

<div class="space-y-4 pt-1" data-slot="scheduled-new-chat-configuration">
	<div class="space-y-2">
		<label for="scheduled-project-path" class="block text-sm font-medium text-muted-foreground">
			{m.chat_new_chat_project_path()}
		</label>
		<div class="relative">
			<div class="flex gap-2">
				<div class="relative min-w-0 flex-1">
					<input
						id="scheduled-project-path"
						type="text"
						value={startup.projectPath}
						readonly={startup.isUpdatingPinnedPath}
						onfocus={() => startup.handlePathFocus()}
						oninput={(event) => {
							startup.projectPath = event.currentTarget.value;
							startup.clearError();
							startup.resetTabCompletions();
						}}
						onkeydown={handlePathKeydown}
						placeholder={startup.projectBasePath}
						class="w-full rounded-lg border border-border bg-background py-2 pl-3 pr-8 text-base text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
					/>
					<div class="absolute right-2 top-1/2 -translate-y-1/2">
						{#if startup.validationStatus === 'checking'}
							<Loader2 class="size-4 animate-spin text-muted-foreground" />
						{:else if startup.validationStatus === 'valid'}
							<Check class="size-4 text-primary" />
						{:else if startup.validationStatus === 'invalid'}
							<X class="size-4 text-destructive" />
						{/if}
					</div>
				</div>
				<ProjectPinnedPathToggleButton
					isPinned={startup.isPinnedPath}
					disabled={!startup.trimmedPath || startup.isUpdatingPinnedPath}
					loading={startup.isUpdatingPinnedPath}
					class="rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:bg-muted/50 disabled:opacity-40"
					onToggle={() => startup.togglePinnedPath()}
				/>
				<ChatTagToggleButton
					active={startup.chatTags.length > 0}
					onToggle={() => startup.toggleTagInput()}
				/>
			</div>
			{#if startup.showBrowser && !startup.isUpdatingPinnedPath}
				<DirectoryBrowser
					currentPath={startup.trimmedPath || startup.browseStartPath || startup.projectBasePath}
					basePath={startup.projectBasePath}
					onSelect={(path) => {
						startup.projectPath = path;
						startup.clearError();
					}}
					onClose={() => (startup.showBrowser = false)}
					{isMobile}
				/>
			{/if}
		</div>

		<div class="-mt-1 min-h-5">
			{#if startup.validationStatus === 'invalid' && startup.validationError}
				<p class="text-xs text-destructive">{startup.validationError}</p>
			{:else if startup.gitRepoStatus === 'git'}
				<button
					type="button"
					disabled={startup.isUpdatingPinnedPath}
					onclick={() => startup.openWorktreeModal()}
					class="flex items-center gap-1.5 text-xs text-interactive-accent transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline"
				>
					{m.chat_new_chat_select_different_worktree()}
				</button>
			{/if}
		</div>

		<ProjectPinnedPathList
			pinnedProjectPaths={startup.pinnedProjectPaths}
			selectedPath={startup.projectPath}
			emptyLabel={m.chat_new_chat_star_bookmark()}
			disabled={startup.isUpdatingPinnedPath}
			onSelect={(path) => {
				startup.projectPath = path;
				startup.clearError();
			}}
		/>

		<ChatTagEditor
			tags={startup.chatTags}
			{knownTags}
			open={startup.showTagInput}
			onAdd={(raw) => startup.addTag(raw)}
			onRemove={(tag) => startup.removeTag(tag)}
			onClose={() => (startup.showTagInput = false)}
		/>

		{#if startup.modelSelectionError}
			<p class="text-sm text-destructive">{startup.modelSelectionError}</p>
		{/if}
	</div>

	<ScheduledPromptField
		bind:ref={textarea}
		{prompt}
		{promptError}
		targetType="new-chat"
		surface="composer"
		{onPromptChange}
		{onPromptKeydown}
	>
		{#snippet controls()}
			<div data-slot="scheduled-new-chat-composer-controls">
				<ComposerBottomBar
					canAttachImages={false}
					attachImagesTooltip=""
					onAddImage={() => {}}
					{permissionOptions}
					selectedPermission={startup.permissionMode}
					onPermissionSelect={(mode) => startup.setPermissionMode(mode)}
					{thinkingOptions}
					selectedThinking={startup.thinkingMode}
					onThinkingSelect={(mode) => startup.setThinkingMode(mode)}
					canSend={false}
					onSend={() => {}}
					sendTitle=""
					sendButtonClass=""
					showAddMenu={false}
					showSendButton={false}
					mobileRightGroupFullRow={true}
				>
					{#snippet agentSettings()}
						<AgentSettingsControls
							descriptors={startup.agentSettingDescriptors}
							envelope={startup.agentSettings}
							onChange={(descriptor, value) => startup.setAgentSetting(descriptor, value)}
						/>
					{/snippet}
					{#snippet modelSelector()}
						<ComposerModelSelector
							value={modelSelectorValue}
							mode={modelSelectorMode}
							onChange={handleModelChange}
							recents={recentSelectorOptions}
							{preferRecentsOnOpen}
							{selectableAgentIds}
							align="end"
							side="bottom"
						/>
					{/snippet}
				</ComposerBottomBar>
			</div>
		{/snippet}
	</ScheduledPromptField>
</div>

{#if startup.worktreeModalOpen}
	<GitWorktreePickerModal
		worktrees={startup.worktreeItems}
		isLoading={startup.isLoadingWorktrees}
		isCreating={startup.isCreatingWorktree}
		errorMessage={startup.worktreeError}
		onSelect={(path) => startup.selectWorktree(path)}
		onCreate={async (path, branch, baseRef) => {
			await startup.createWorktree(path, branch, baseRef);
		}}
		onRefresh={() => {
			void startup.loadWorktrees();
		}}
		onClose={() => startup.closeWorktreeModal()}
	/>
{/if}
