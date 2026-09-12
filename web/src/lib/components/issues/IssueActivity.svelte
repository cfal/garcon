<script lang="ts">
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import { issueActivityLabel, type IssueChatSummary } from './issue-presentation.js';
	import IssueActor from './IssueActor.svelte';
	import IssueMarkdown from './IssueMarkdown.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		chats,
		username,
		onOpenChat,
	}: {
		controller: IssuesController;
		chats: readonly IssueChatSummary[];
		username: string;
		onOpenChat: (id: string) => void;
	} = $props();
</script>

<p class="issue-notice">{m.issues_history_warning()}</p>
{#if controller.detail.historyError}<div class="issue-notice" role="alert">
		<p>{controller.detail.historyError}</p>
		<button
			class="issue-button"
			disabled={!!controller.pagePending}
			onclick={() => void controller.loadHistory()}>{m.issues_retry()}</button
		>
	</div>{/if}
{#if controller.detail.history?.nextBeforeSequence !== null && controller.detail.history}<button
		class="issue-button"
		disabled={!!controller.pagePending}
		onclick={() => void controller.loadOlderHistory()}>{m.issues_older_activity()}</button
	>{/if}
<ol class="issue-activity">
	{#each controller.detail.history?.items ?? [] as entry (entry.sequence)}
		<svelte:boundary>
			<li>
				<p>
					<IssueActor actor={entry.actor} {chats} {username} {onOpenChat} />
					{issueActivityLabel(entry.action)}
				</p>
				<time class="issue-muted" datetime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
				{#if 'changes' in entry}<dl class="issue-changes">
						{#each entry.changes as change (change.field)}<dt>{change.field}</dt>
							<dd>
								<span>{JSON.stringify(change.before)}</span> →
								<span>{JSON.stringify(change.after)}</span>
							</dd>{/each}
					</dl>
				{:else if 'commentId' in entry}<details>
						<summary>{m.issues_details()}</summary>{#if entry.before !== null}<h4>
								{m.issues_before()}
							</h4>
							<IssueMarkdown text={entry.before} />{/if}{#if entry.after !== null}<h4>
								{m.issues_after()}
							</h4>
							<IssueMarkdown text={entry.after} />{/if}
					</details>
				{:else if 'targetId' in entry}<p>{entry.sourceId} → {entry.targetId} · {entry.kind}</p>{/if}
				{#if entry.source}<p class="issue-muted">
						{m.issues_source_address({
							chat: entry.source.chatId,
							view: entry.source.transcriptViewId,
							ordinal: entry.source.ordinal,
						})}
					</p>{/if}
			</li>
			{#snippet failed()}<li class="issue-notice">{m.issues_invalid_entry()}</li>{/snippet}
		</svelte:boundary>
	{:else}{#if !controller.detail.historyError}<li class="issue-muted">
				{controller.pagePending ? m.issues_loading() : m.issues_no_activity()}
			</li>{/if}{/each}
</ol>
