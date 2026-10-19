<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import ScheduledNewChatComposer from '$lib/components/settings/ScheduledNewChatComposer.svelte';
	import {
		getChatSessions,
		getExecutors,
		getLocalSettings,
		getModelCatalog,
		getRemoteSettings,
	} from '$lib/context';
	import { nonDirectAgentIds } from '$lib/agents/direct-agents.js';
	import { agentLabelFor } from '$lib/agents/agent-labels';
	import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types';
	import {
		PULL_REQUEST_REVIEW_PROMPT_TOKENS,
		type PullRequestReviewRepository,
		type PullRequestReviewRepositoryInput,
	} from '$shared/pull-request-reviews';
	import { errorMessage } from '$lib/utils/error-message.js';
	import * as m from '$lib/paraglide/messages.js';
	import { PullRequestRepositoryFormState } from './pull-request-repository-form-state.svelte';

	interface Props {
		repository: PullRequestReviewRepository | null;
		onSave: (input: PullRequestReviewRepositoryInput) => Promise<void>;
		onClose: () => void;
	}

	let { repository, onSave, onClose }: Props = $props();
	const rootModelCatalog = getModelCatalog();
	const executors = getExecutors();
	const localSettings = getLocalSettings();
	const remoteSettings = getRemoteSettings();
	const sessions = getChatSessions();

	function selectableAgentsForExecutor(executorId: string): readonly SessionAgentId[] {
		const allAgentIds = rootModelCatalog.forExecutor(executorId).getSelectableAgents();
		return localSettings.allowDirectChats ? allAgentIds : nonDirectAgentIds(allAgentIds);
	}

	const form: PullRequestRepositoryFormState = new PullRequestRepositoryFormState({
		modelCatalog: rootModelCatalog,
		remoteSettings,
		executors,
		get selectableAgentIds() {
			return selectableAgentIds;
		},
	});
	const selectableAgentIds: readonly SessionAgentId[] = $derived(
		selectableAgentsForExecutor(form.startup.executorId),
	);
	const modelCatalog = $derived(rootModelCatalog.forExecutor(form.startup.executorId));
	const knownTags = $derived(
		Array.from(new Set(sessions.orderedChats.flatMap((chat) => chat.tags))).sort(),
	);
	let isMobile = $state(false);
	let content = $state<HTMLElement | null>(null);

	void untrack(() =>
		form.initialize(repository).catch((error: unknown) => {
			form.error = errorMessage(error, m.pull_request_review_action_failed());
		}),
	);

	// The folder is validated on its executor as it changes.
	$effect(() => {
		void form.startup.nonblankPath;
		void form.startup.pathContextKey;
		untrack(() => form.startup.validatePath());
	});

	$effect(() => {
		const executorId = form.startup.executorId;
		if (!executors.isReady(executorId)) return;
		untrack(
			() =>
				void form.loadStartupWhenReady().catch((error: unknown) => {
					form.error = errorMessage(error, m.pull_request_review_action_failed());
				}),
		);
		const catalog = rootModelCatalog.forExecutor(executorId);
		void catalog.version;
		untrack(() => void catalog.refreshIfStale());
	});

	$effect(() => {
		if (!form.startup.executorReady) return;
		void modelCatalog.version;
		form.startup.validateAllModelsAgainstLive();
	});

	$effect(() => {
		if (!form.startup.executorReady) return;
		const eligibleAgentIds = selectableAgentIds;
		untrack(() => form.startup.reconcileAgentSelection(eligibleAgentIds));
	});

	onMount(() => {
		const media = window.matchMedia('(max-width: 768px)');
		isMobile = media.matches;
		const handleChange = (event: MediaQueryListEvent) => (isMobile = event.matches);
		media.addEventListener('change', handleChange);
		return () => media.removeEventListener('change', handleChange);
	});

	onDestroy(() => form.dispose());

	async function save(): Promise<void> {
		const input = form.buildInput();
		if (!input) return;
		form.saving = true;
		form.error = null;
		try {
			await onSave(input);
			onClose();
		} catch (error) {
			form.error = errorMessage(error, m.pull_request_repository_save_failed());
		} finally {
			form.saving = false;
		}
	}

	const filterToggles = [
		{ key: 'skipDrafts', label: m.pull_request_repository_filter_skip_drafts },
		{ key: 'trustedAuthorsOnly', label: m.pull_request_repository_filter_trusted },
	] as const;
	const filterLists = [
		{ key: 'baseBranches', label: m.pull_request_repository_base_branches },
		{ key: 'includeLabels', label: m.pull_request_repository_include_labels },
		{ key: 'excludeLabels', label: m.pull_request_repository_exclude_labels },
	] as const;
	const reviewLimits = [
		{
			key: 'maxChangedLines',
			label: m.pull_request_repository_max_changed_lines,
			hint: m.pull_request_repository_max_changed_lines_hint,
			min: 1,
			max: 1_000_000,
		},
		{
			key: 'maxAttemptsPerCommit',
			label: m.pull_request_repository_max_attempts,
			hint: m.pull_request_repository_max_attempts_hint,
			min: 1,
			max: 5,
		},
		{
			key: 'dailyReviewLimit',
			label: m.pull_request_repository_daily_limit,
			hint: m.pull_request_repository_daily_limit_hint,
			min: 1,
			max: 500,
		},
	] as const;
	const promptVariables = {
		tokens: Object.values(PULL_REQUEST_REVIEW_PROMPT_TOKENS),
		help: m.pull_request_repository_prompt_hint({
			repository: PULL_REQUEST_REVIEW_PROMPT_TOKENS.repository,
			url: PULL_REQUEST_REVIEW_PROMPT_TOKENS.repositoryUrl,
			number: PULL_REQUEST_REVIEW_PROMPT_TOKENS.pullRequestNumber,
			path: PULL_REQUEST_REVIEW_PROMPT_TOKENS.projectPath,
		}),
	};
	const sectionClass = 'space-y-3 rounded-lg border border-border p-3';
</script>

<Dialog.Root open onOpenChange={(value) => !value && onClose()}>
	<Dialog.Content
		bind:ref={content}
		class="flex max-h-[90dvh] flex-col sm:max-w-2xl"
		data-pr-repository-dialog
		onOpenAutoFocus={(event) => {
			// Focusing the folder field would open its browser before the executor's settings load.
			event.preventDefault();
			content?.focus();
		}}
	>
		<Dialog.Header>
			<Dialog.Title>
				{repository ? repository.nameWithOwner : m.pull_request_repository_connect()}
			</Dialog.Title>
			<Dialog.Description>{m.pull_request_repository_description()}</Dialog.Description>
		</Dialog.Header>
		<div class="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
			<section class={sectionClass}>
				{#if form.settingsOnlyOffline}
					<p class="text-sm text-muted-foreground" role="status">
						{m.pull_request_repository_offline_settings()}
					</p>
					<p class="truncate text-sm font-medium">
						{agentLabelFor(repository?.target.agentId ?? '')} · {repository?.target.model}
					</p>
					<p class="break-all font-mono text-xs text-muted-foreground">
						{repository?.target.projectPath}
					</p>
					<label class="flex flex-col gap-2 text-sm">
						{m.pull_request_repository_prompt_label()}
						<textarea
							class="min-h-32 w-full rounded-md border border-border bg-background p-2 text-base pointer-fine:text-sm"
							bind:value={form.prompt}></textarea>
					</label>
					<p class="text-xs text-muted-foreground">{promptVariables.help}</p>
				{:else}
					<ScheduledNewChatComposer
						conversationInput
						startup={form.startup}
						{modelCatalog}
						{remoteSettings}
						getSelectableAgentIds={selectableAgentsForExecutor}
						prompt={form.prompt}
						{promptVariables}
						promptError={form.promptError}
						{knownTags}
						{isMobile}
						onPromptChange={(value) => (form.prompt = value)}
						onPromptKeydown={() => {}}
						onSnippetPendingChange={(pending) => (form.promptTransformPending = pending)}
					/>
				{/if}
			</section>
			<section class={sectionClass}>
				<div class="flex items-start justify-between gap-3">
					<div>
						<p class="text-sm font-medium text-foreground">
							{m.pull_request_repository_auto_review()}
						</p>
						<p class="text-xs text-muted-foreground">
							{m.pull_request_repository_auto_review_description()}
						</p>
					</div>
					<Switch
						checked={form.autoReview}
						onCheckedChange={(next) => (form.autoReview = Boolean(next))}
						aria-label={m.pull_request_repository_auto_review()}
					/>
				</div>
				<div class="grid gap-2 sm:grid-cols-2">
					{#each filterToggles as toggle (toggle.key)}
						<label class="flex items-center gap-2 text-sm">
							<input type="checkbox" bind:checked={form.filters[toggle.key]} />
							{toggle.label()}
						</label>
					{/each}
					<label class="flex items-center gap-2 text-sm">
						<input type="checkbox" bind:checked={form.onlyWhenReviewRequested} />
						{m.pull_request_repository_only_requested()}
					</label>
				</div>
				{#if !form.filters.trustedAuthorsOnly}
					<p
						class="rounded-md border border-status-warning-border bg-status-warning px-3 py-2 text-xs text-status-warning-foreground"
					>
						{m.pull_request_repository_untrusted_warning()}
					</p>
				{/if}
				<label class="flex items-center gap-2 text-sm">
					{m.pull_request_repository_debounce()}
					<input
						type="number"
						min="0"
						max="1440"
						step="1"
						class="w-20 rounded-md border border-border bg-background px-2 py-1 text-base pointer-fine:text-sm"
						bind:value={form.debounceMinutes}
					/>
				</label>
				<p class="text-xs text-muted-foreground">
					{m.pull_request_repository_debounce_hint()}
				</p>
				<details class="space-y-3">
					<summary class="cursor-pointer text-sm font-medium">
						{m.pull_request_repository_filters_and_limits()}
					</summary>
					<p id="pr-filter-lists-hint" class="text-xs text-muted-foreground">
						{m.pull_request_repository_filter_lists_hint()}
					</p>
					<div class="grid gap-3 sm:grid-cols-3">
						{#each filterLists as filter (filter.key)}
							<label class="flex flex-col gap-1 text-sm">
								{filter.label()}
								<textarea
									class="w-full rounded-md border border-border bg-background px-2 py-1 text-base pointer-fine:text-sm"
									rows="2"
									aria-describedby="pr-filter-lists-hint"
									bind:value={form[filter.key]}></textarea>
							</label>
						{/each}
					</div>
					<div class="grid gap-3 sm:grid-cols-3">
						{#each reviewLimits as limit (limit.key)}
							<div class="flex flex-col gap-1 text-sm">
								<label for={`pr-limit-${limit.key}`}>{limit.label()}</label>
								<input
									id={`pr-limit-${limit.key}`}
									type="number"
									min={limit.min}
									max={limit.max}
									step="1"
									class="w-full rounded-md border border-border bg-background px-2 py-1 text-base pointer-fine:text-sm"
									aria-describedby={`pr-limit-${limit.key}-hint`}
									bind:value={form[limit.key]}
								/>
								<p id={`pr-limit-${limit.key}-hint`} class="text-xs text-muted-foreground">
									{limit.hint()}
								</p>
							</div>
						{/each}
					</div>
				</details>
				{#if form.settingsError}
					<p class="text-sm text-status-error-foreground" role="alert">{form.settingsError}</p>
				{/if}
			</section>
			<section class={sectionClass}>
				<label class="flex items-start gap-2 text-sm font-medium text-foreground">
					<input type="checkbox" class="mt-0.5" bind:checked={form.autoPost} />
					{m.pull_request_repository_auto_post()}
				</label>
				<p class="text-xs text-muted-foreground">
					{m.pull_request_repository_auto_post_description()}
				</p>
				<p class="text-xs text-muted-foreground">
					{repository?.viewerLogin
						? m.pull_request_review_posts_as({ login: `@${repository.viewerLogin}` })
						: m.pull_request_repository_posting_identity()}
				</p>
			</section>
			{#if form.error}
				<p class="text-sm text-status-error-foreground" role="alert">{form.error}</p>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="ghost" onclick={onClose}>{m.common_cancel()}</Button>
			<Button disabled={!form.canSave} onclick={save} data-pr-repository-save>
				{form.saving
					? m.common_saving()
					: repository
						? m.common_save()
						: m.pull_request_repository_connect()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
