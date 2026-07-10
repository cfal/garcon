<script lang="ts">
	import { onDestroy } from 'svelte';
	import ComposerBottomBar from '$lib/components/chat/ComposerBottomBar.svelte';
	import DirectoryBrowser from '$lib/components/chat/DirectoryBrowser.svelte';
	import ProjectPinnedPathList from '$lib/components/chat/ProjectPinnedPathList.svelte';
	import ProjectPinnedPathToggleButton from '$lib/components/chat/ProjectPinnedPathToggleButton.svelte';
	import ComposerModelSelector from '$lib/components/model-selector/ComposerModelSelector.svelte';
	import type { NewChatFormState } from '$lib/chat/new-chat-form-state.svelte';
	import { buildPermissionOptions, buildThinkingOptions } from '$lib/chat/composer-controls';
	import {
		CLAUDE_PERMISSION_MODES,
		NON_CLAUDE_PERMISSION_MODES,
	} from '$lib/chat/chat-ui-constants';
	import { buildModelSelectorRecents } from '$lib/components/model-selector/model-selector-recents';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
	} from '$lib/components/model-selector/model-selector-types';
	import type { ModelCatalogStore } from '$lib/stores/model-catalog.svelte';
	import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
	import Check from '@lucide/svelte/icons/check';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		startup: NewChatFormState;
		modelCatalog: ModelCatalogStore;
		remoteSettings: RemoteSettingsStore;
		prompt: string;
		promptError: string | null;
		isMobile: boolean;
		onPromptChange: (value: string) => void;
		onPromptKeydown: (event: KeyboardEvent) => void;
	}

	let {
		startup,
		modelCatalog,
		remoteSettings,
		prompt,
		promptError,
		isMobile,
		onPromptChange,
		onPromptKeydown,
	}: Props = $props();
	let textarea: HTMLTextAreaElement | undefined = $state();
	let resizeFrame: number | null = null;

	const permissionOptions = $derived(
		buildPermissionOptions(
			startup.agentId === 'claude' ? CLAUDE_PERMISSION_MODES : NON_CLAUDE_PERMISSION_MODES,
		),
	);
	const thinkingOptions = $derived(buildThinkingOptions());
	const modelSelectorMode: ModelSelectorMode = {
		agent: 'select',
		source: 'select',
		surface: 'composer',
	};
	const modelSelectorValue = $derived({
		agentId: startup.agentId,
		model: startup.modelValue,
	});
	const recentSelectorOptions = $derived.by(() =>
		buildModelSelectorRecents(modelCatalog, remoteSettings.snapshot?.recentAgentSettings ?? []),
	);
	const preferRecentsOnOpen = $derived(recentSelectorOptions.length > 1);

	function resizeTextarea(): void {
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = `${textarea.scrollHeight}px`;
	}

	$effect(() => {
		prompt;
		textarea;
		if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
		resizeFrame = requestAnimationFrame(() => {
			resizeFrame = null;
			resizeTextarea();
		});
		return () => {
			if (resizeFrame === null) return;
			cancelAnimationFrame(resizeFrame);
			resizeFrame = null;
		};
	});

	onDestroy(() => {
		if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
	});

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

	function handlePromptInput(event: Event): void {
		onPromptChange((event.currentTarget as HTMLTextAreaElement).value);
		resizeTextarea();
	}

	function handleModelChange(next: ModelSelectorChange): void {
		startup.selectAgent(next.agentId);
		startup.handleModelChange(next.modelValue);
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
						class="w-full rounded-lg border border-border bg-background py-2 pl-3 pr-8 text-base text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
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
	</div>

	<div>
		<div
			class="relative min-h-[120px] rounded-lg border border-border pb-1.5"
			data-slot="scheduled-new-chat-composer"
		>
			<textarea
				bind:this={textarea}
				value={prompt}
				oninput={handlePromptInput}
				onkeydown={onPromptKeydown}
				rows="2"
				aria-label={m.scheduled_tasks_prompt()}
				placeholder={m.scheduled_tasks_prompt_placeholder()}
				class="chat-input-placeholder block min-h-11 max-h-[40vh] w-full resize-none overflow-y-auto bg-transparent px-4 py-1.5 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground sm:max-h-[500px] sm:py-3"
			></textarea>

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
					showAttachmentControl={false}
					showSendButton={false}
					mobileRightGroupFullRow={true}
				>
					{#snippet modelSelector()}
						<ComposerModelSelector
							value={modelSelectorValue}
							mode={modelSelectorMode}
							onChange={handleModelChange}
							recents={recentSelectorOptions}
							{preferRecentsOnOpen}
							align="end"
							side="bottom"
						/>
					{/snippet}
				</ComposerBottomBar>
			</div>
		</div>
		<div class="min-h-5 pt-1">
			{#if prompt.length > 0 && promptError}
				<p class="text-xs text-destructive">{promptError}</p>
			{/if}
		</div>
	</div>
</div>
