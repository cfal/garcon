<script lang="ts">
	import { tick, untrack } from 'svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Copy from '@lucide/svelte/icons/copy';
	import type { IssueDetail, IssueSource, IssueStatus } from '$shared/issues';
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import {
		canSubmitIssueForm,
		issueEditorFields,
		submitIssueForm,
	} from '$lib/issues/commands/issue-form.js';
	import { copyToClipboard } from '$lib/utils/clipboard.js';
	import {
		issueDeepLink,
		issuePriorityLabel,
		isIssueProjectPath,
		type IssueChatSummary,
	} from './issue-presentation.js';
	import IssueStatusMenu from './IssueStatusMenu.svelte';
	import IssueFieldsEditor from './IssueFieldsEditor.svelte';
	import IssueDraftFeedback from './IssueDraftFeedback.svelte';
	import IssueDiscussion from './IssueDiscussion.svelte';
	import IssueActivity from './IssueActivity.svelte';
	import IssueRelationships from './IssueRelationships.svelte';
	import IssueMarkdown from './IssueMarkdown.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		detail,
		chats,
		username,
		onOpenChat,
		onOpenSource,
		onBack,
		onStatus,
	}: {
		controller: IssuesController;
		detail: IssueDetail;
		chats: readonly IssueChatSummary[];
		username: string;
		onOpenChat: (id: string) => void;
		onOpenSource: (source: IssueSource) => void;
		onBack: () => void;
		onStatus: (status: IssueStatus) => void;
	} = $props();
	const editing = $derived(controller.detail.fieldsDraft);
	let copied = $state('');
	let cancelRequested = $state(false);
	let composing = $state(false);
	let scroll = $state<HTMLElement | null>(null);
	let priorComments: IssueDetail['comments'] | null = null;
	const issue = $derived(detail.issue);
	const ownAssignment = $derived(
		issue.assignee?.kind === 'user' && issue.assignee.username === username,
	);
	const assignedChatId = $derived(issue.assignee?.kind === 'chat' ? issue.assignee.chatId : null);
	function edit() {
		controller.detail.fieldsDraft = controller.drafts.open(
			'fields',
			detail,
			issueEditorFields(issue),
		);
	}
	function cancel() {
		if (editing?.pending) return;
		if (editing?.needsExitGuard) cancelRequested = true;
		else controller.detail.fieldsDraft = null;
	}
	async function save() {
		if (!editing || composing || !canSubmitIssueForm(editing)) return;
		await submitIssueForm(editing);
	}
	async function copyLink() {
		copied = (await copyToClipboard(issueDeepLink(issue.id)))
			? m.issues_copied()
			: m.issues_copy_failed();
	}
	async function latestComments() {
		await controller.latestDetail();
		await tick();
		if (scroll) scroll.scrollTop = scroll.scrollHeight;
		controller.detail.newComments = false;
	}
	$effect.pre(() => {
		const comments = detail.comments;
		untrack(() => {
			const element = scroll;
			if (!element || !priorComments || comments === priorComments) {
				priorComments = comments;
				return;
			}
			priorComments = comments;
			const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
			const anchor = [...element.querySelectorAll<HTMLElement>('[data-comment-id]')].find(
				(node) => node.getBoundingClientRect().bottom >= element.getBoundingClientRect().top,
			);
			const offset = anchor?.getBoundingClientRect().top;
			void tick().then(() => {
				if (!element.isConnected) return;
				if (nearBottom) {
					element.scrollTop = element.scrollHeight;
					controller.detail.newComments = false;
				} else if (anchor?.isConnected && offset !== undefined)
					element.scrollTop += anchor.getBoundingClientRect().top - offset;
			});
		});
	});
</script>

<section
	class="issue-detail"
	aria-label={m.issues_details()}
	bind:this={scroll}
	data-issue-scroll={`detail:${issue.id}`}
>
	{#if controller.detail.error}<div class="issue-notice" role="alert">
			<p>{controller.detail.error}</p>
			<button class="issue-button" onclick={() => void controller.refresh()}
				>{m.issues_retry()}</button
			>
		</div>{/if}
	<div class="issue-detail-header">
		<button
			type="button"
			class="issue-button issue-back"
			onclick={onBack}
			data-issue-focus={JSON.stringify({ kind: 'toolbar', control: 'back' })}
			><ArrowLeft size={15} />{m.issues_back()}</button
		>
		<span class="issue-id">{issue.id}</span><button
			type="button"
			class="issue-text-button"
			onclick={() => void copyLink()}
			aria-label={m.issues_copy_link()}><Copy size={14} /></button
		>
		<IssueStatusMenu {issue} {onStatus} />
	</div>
	{#if copied}<p class="issue-muted" role="status">{copied}</p>{/if}
	{#if editing}
		<form
			class="issue-editor"
			onsubmit={(event) => {
				event.preventDefault();
				void save();
			}}
			oncompositionstart={() => (composing = true)}
			oncompositionend={() => (composing = false)}
		>
			<IssueFieldsEditor
				{controller}
				draft={editing}
				{chats}
				{username}
				onSubmit={() => void save()}
			/><IssueDraftFeedback draft={editing} />
			<div class="issue-actions">
				<button type="button" class="issue-button" disabled={editing.pending} onclick={cancel}
					>{m.issues_cancel()}</button
				><button
					class="issue-button issue-primary"
					disabled={!canSubmitIssueForm(editing) || composing}
					>{editing.pending ? m.issues_saving() : m.issues_save()}</button
				>
			</div>
			{#if cancelRequested}<div class="issue-notice">
					<p>{m.issues_discard_confirm()}</p>
					<button
						type="button"
						class="issue-button"
						onclick={() => {
							editing?.discard();
							controller.detail.fieldsDraft = null;
							cancelRequested = false;
						}}>{m.issues_discard()}</button
					><button type="button" class="issue-button" onclick={() => (cancelRequested = false)}
						>{m.issues_keep()}</button
					>
				</div>{/if}
		</form>
	{:else}
		<h1
			class="issue-detail-title"
			tabindex="-1"
			data-issue-focus={JSON.stringify({ kind: 'toolbar', control: 'detail' })}
		>
			{issue.title}
		</h1>
		<div class="issue-actions">
			<button type="button" class="issue-button" onclick={edit}>{m.issues_edit()}</button>
			{#if issue.status !== 'closed' && !issue.assignee}<button
					type="button"
					class="issue-button"
					onclick={() =>
						void controller.mutate(issue, {
							action: 'claim',
							issueId: issue.id,
							expectedRevision: issue.revision,
						})}>{m.issues_claim()}</button
				>{/if}
			{#if ownAssignment}<button
					type="button"
					class="issue-button"
					onclick={() =>
						void controller.mutate(issue, {
							action: 'release',
							issueId: issue.id,
							expectedRevision: issue.revision,
						})}>{m.issues_release()}</button
				>{/if}
			<button
				type="button"
				class="issue-button"
				onclick={() => onStatus(issue.status === 'closed' ? 'open' : 'closed')}
				>{issue.status === 'closed' ? m.issues_reopen() : m.issues_close()}</button
			>
		</div>
		<dl class="issue-properties-read">
			<dt>{m.issues_project()}</dt>
			<dd class="issue-project" data-path={isIssueProjectPath(issue.project)} title={issue.project}>
				{issue.project}
			</dd>
			<dt>{m.issues_priority()}</dt>
			<dd class="issue-priority" data-priority={issue.priority}>
				{issuePriorityLabel(issue.priority)}
			</dd>
			<dt>{m.issues_assignee()}</dt>
			<dd>
				{assignedChatId
					? (chats.find((chat) => chat.id === assignedChatId)?.title ?? assignedChatId)
					: issue.assignee?.kind === 'user'
						? issue.assignee.username
						: m.issues_unassigned()}
			</dd>
			{#if issue.labels.length}<dt>{m.issues_labels()}</dt>
				<dd>{issue.labels.join(' · ')}</dd>{/if}
			{#if issue.parentId}<dt>{m.issues_parent()}</dt>
				<dd>
					<button
						type="button"
						class="issue-text-button"
						onclick={() => controller.select(issue.parentId)}>{issue.parentId}</button
					>
				</dd>{/if}
		</dl>
		{#if issue.description}<IssueMarkdown text={issue.description} />{:else}<p
				class="issue-muted py-4"
			>
				{m.issues_no_description()}
			</p>{/if}
	{/if}
	<IssueRelationships {controller} {detail} />
	<nav class="issue-detail-tabs" aria-label={m.issues_details()}>
		<button
			type="button"
			aria-pressed={controller.detail.tab === 'comments'}
			onclick={() => (controller.detail.tab = 'comments')}>{m.issues_comments()}</button
		>
		<button
			type="button"
			aria-pressed={controller.detail.tab === 'activity'}
			onclick={() => {
				controller.detail.tab = 'activity';
				void controller.loadHistory();
			}}>{m.issues_activity()}</button
		>
		<button
			type="button"
			class="issue-text-button"
			onclick={() => {
				void controller.latestDetail();
			}}>{m.issues_latest()}</button
		>
	</nav>
	{#if controller.detail.tab === 'comments'}<IssueDiscussion
			{controller}
			{detail}
			{chats}
			{username}
			{onOpenChat}
			onSubmitted={() => void latestComments()}
		/>
	{:else}<IssueActivity {controller} {chats} {username} {onOpenChat} {onOpenSource} />{/if}
</section>
