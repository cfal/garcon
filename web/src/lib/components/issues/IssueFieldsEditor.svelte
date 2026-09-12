<script lang="ts">
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import type { IssueDraftState } from '$lib/issues/drafts/issue-draft-state.svelte.js';
	import type { IssueChatSummary } from './issue-presentation.js';
	import { issuePriorityLabel } from './issue-presentation.js';
	import type { IssuePriority } from '$shared/issues';
	import { isIssueSubmitKey } from '$lib/issues/commands/issue-form.js';
	import IssueProjectInput from './IssueProjectInput.svelte';
	import IssueLabelsInput from './IssueLabelsInput.svelte';
	import IssueMarkdown from './IssueMarkdown.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		draft,
		chats,
		username,
		onSubmit,
	}: {
		controller: IssuesController;
		draft: IssueDraftState;
		chats: readonly IssueChatSummary[];
		username: string;
		onSubmit: () => void;
	} = $props();
	let preview = $state(false);
	function keydown(event: KeyboardEvent) {
		if (
			isIssueSubmitKey(
				event,
				draft.current.kind === 'create' &&
					event.target instanceof HTMLInputElement &&
					event.target.classList.contains('issue-title-input'),
			)
		) {
			event.preventDefault();
			onSubmit();
		}
	}
</script>

<fieldset disabled={!draft.canEdit} class="issue-fields">
	<label class="issue-field"
		>{m.issues_title_field()}
		<input
			class="issue-input issue-title-input"
			value={draft.field('title')}
			maxlength={480}
			onkeydown={keydown}
			data-issue-focus={JSON.stringify({
				kind: 'draft',
				draftId: draft.current.id,
				field: 'title',
			})}
			data-draft-version={draft.current.version}
			oninput={(event) => draft.setField('title', event.currentTarget.value)}
			required
		/>
	</label>
	<div class="issue-actions">
		<span class="issue-field-label">{m.issues_description()}</span><button
			type="button"
			class="issue-text-button"
			aria-pressed={preview}
			onclick={() => (preview = !preview)}>{preview ? m.issues_write() : m.issues_preview()}</button
		>
	</div>
	{#if preview}<IssueMarkdown text={draft.field('description')} />
	{:else}<label class="issue-field"
			><span class="sr-only">{m.issues_description()}</span>
			<textarea
				class="issue-input"
				rows="6"
				value={draft.field('description')}
				onkeydown={keydown}
				data-issue-focus={JSON.stringify({
					kind: 'draft',
					draftId: draft.current.id,
					field: 'description',
				})}
				data-draft-version={draft.current.version}
				oninput={(event) => draft.setField('description', event.currentTarget.value)}></textarea>
		</label>{/if}
	<IssueProjectInput
		{controller}
		value={draft.field('project')}
		disabled={!draft.canEdit}
		onChange={(value) => draft.setField('project', value)}
		onKeydown={keydown}
	/>
	<details open={draft.current.kind !== 'create'}>
		<summary>{m.issues_more_details()}</summary>
		<div class="issue-properties">
			<label class="issue-field"
				>{m.issues_priority()}<select
					class="issue-input"
					onkeydown={keydown}
					value={draft.field('priority') || '2'}
					onchange={(event) => draft.setField('priority', event.currentTarget.value)}
				>
					{#each [0, 1, 2, 3] as priority (priority)}<option value={String(priority)}
							>{issuePriorityLabel(priority as IssuePriority)}</option
						>{/each}
				</select></label
			>
			<label class="issue-field"
				>{m.issues_assignee()}<select
					class="issue-input"
					onkeydown={keydown}
					value={draft.field('assignee')}
					onchange={(event) => draft.setField('assignee', event.currentTarget.value)}
				>
					<option value="">{m.issues_unassigned()}</option><option value={`user:${username}`}
						>{m.issues_me()}</option
					>
					{#if draft
						.field('assignee')
						.startsWith('user:') && draft.field('assignee') !== `user:${username}`}<option
							value={draft.field('assignee')}>{draft.field('assignee').slice(5)}</option
						>{/if}
					{#each chats as chat (chat.id)}<option value={`chat:${chat.id}`}
							>{chat.title || chat.id} · …{chat.id.slice(-4)}</option
						>{/each}
					{#if draft
						.field('assignee')
						.startsWith('chat:') && !chats.some((chat) => `chat:${chat.id}` === draft.field('assignee'))}<option
							value={draft.field('assignee')}
							>{m.issues_deleted_chat({ id: draft.field('assignee').slice(5) })}</option
						>{/if}
				</select></label
			>
			<label class="issue-field"
				>{m.issues_parent()}<input
					class="issue-input"
					placeholder="ISS-42"
					value={draft.field('parentId')}
					onkeydown={keydown}
					oninput={(event) => draft.setField('parentId', event.currentTarget.value)}
				/></label
			>
			<IssueLabelsInput {controller} {draft} onKeydown={keydown} />
		</div>
	</details>
</fieldset>
