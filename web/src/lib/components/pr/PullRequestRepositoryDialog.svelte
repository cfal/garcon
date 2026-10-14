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
	const selectableAgentIds: readonly SessionAgentId[] = $derived(selectableAgentsForExecutor(form.startup.executorId));
	const modelCatalog = $derived(rootModelCatalog.forExecutor(form.startup.executorId));
	const knownTags = $derived(
		Array.from(new Set(sessions.orderedChats.flatMap((chat) => chat.tags))).sort(),
	);
	let isMobile = $state(false);

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
		const catalog = rootModelCatalog.forExecutor(executorId);
		void catalog.version;
		untrack(() => void catalog.refreshIfStale());
	});

	$effect(() => {
		void modelCatalog.version;
		form.startup.validateAllModelsAgainstLive();
	});

	$effect(() => {
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
		{ key: 'skipBots', label: m.pull_request_repository_filter_skip_bots },
		{ key: 'trustedAuthorsOnly', label: m.pull_request_repository_filter_trusted },
		{ key: 'includeForks', label: m.pull_request_repository_filter_forks },
	] as const;
	const sectionClass = 'space-y-3 rounded-lg border border-border p-3';
</script>

<Dialog.Root open onOpenChange={(value) => !value && onClose()}>
	<Dialog.Content class="flex max-h-[90dvh] flex-col sm:max-w-2xl" data-pr-repository-dialog>
		<Dialog.Header>
			<Dialog.Title>
				{repository ? repository.nameWithOwner : m.pull_request_repository_connect()}
			</Dialog.Title>
			<Dialog.Description>{m.pull_request_repository_description()}</Dialog.Description>
		</Dialog.Header>
		<div class="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
			<section class={sectionClass}>
				<ScheduledNewChatComposer
					conversationInput
					startup={form.startup}
					{modelCatalog}
					{remoteSettings}
					getSelectableAgentIds={selectableAgentsForExecutor}
					prompt={form.prompt}
					promptError={form.promptError}
					{knownTags}
					{isMobile}
					onPromptChange={(value) => (form.prompt = value)}
					onPromptKeydown={() => {}}
					onSnippetPendingChange={(pending) => (form.promptTransformPending = pending)}
				/>
				<p class="text-xs text-muted-foreground">{m.pull_request_repository_prompt_hint({
						repository: PULL_REQUEST_REVIEW_PROMPT_TOKENS.repository,
						number: PULL_REQUEST_REVIEW_PROMPT_TOKENS.pullRequestNumber,
						path: PULL_REQUEST_REVIEW_PROMPT_TOKENS.projectPath,
					})}</p>
			</section>
			<section class={sectionClass}>
				<div class="flex items-start justify-between gap-3">
					<div>
						<p class="text-sm font-medium text-foreground">{m.pull_request_repository_auto_review()}</p>
						<p class="text-xs text-muted-foreground">{m.pull_request_repository_auto_review_description()}</p>
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
				{#if form.filters.includeForks || !form.filters.trustedAuthorsOnly}
					<p class="rounded-md border border-status-warning-border bg-status-warning px-3 py-2 text-xs text-status-warning-foreground">
						{m.pull_request_repository_untrusted_warning()}
					</p>
				{/if}
				<label class="flex items-center gap-2 text-sm">
					{m.pull_request_repository_debounce()}
					<input
						type="number"
						min="0"
						max="1440"
						class="w-20 rounded-md border border-border bg-background px-2 py-1 text-base pointer-fine:text-sm"
						bind:value={form.debounceMinutes}
					/>
				</label>
			</section>
			<section class={sectionClass}>
				<label class="flex flex-col gap-1 text-sm">
					<span class="font-medium text-foreground">{m.pull_request_repository_posting()}</span>
					<select class="select-native text-base pointer-fine:text-sm" bind:value={form.posting}>
						<option value="off">{m.pull_request_repository_posting_off()}</option>
						<option value="draft">{m.pull_request_repository_posting_draft()}</option>
						<option value="comment">{m.pull_request_repository_posting_comment()}</option>
					</select>
				</label>
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
				{form.saving ? m.common_saving() : repository ? m.common_save() : m.pull_request_repository_connect()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
