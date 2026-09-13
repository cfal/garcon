<script lang="ts">
	import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte.js';
	import type { TicketDraftState } from '$lib/tickets/drafts/ticket-draft-state.svelte.js';
	import type { TicketChatSummary } from './ticket-presentation.js';
	import { ticketPriorityLabel } from './ticket-presentation.js';
	import type { TicketPriority } from '$shared/tickets';
	import { isTicketSubmitKey } from '$lib/tickets/commands/ticket-form.js';
	import TicketProjectInput from './TicketProjectInput.svelte';
	import TicketLabelsInput from './TicketLabelsInput.svelte';
	import TicketTextEditor from './TicketTextEditor.svelte';
	import ProjectPinnedPathList from '$lib/components/chat/ProjectPinnedPathList.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		draft,
		chats,
		username,
		onSubmit,
		onRefinementPendingChange,
		active = true,
		pinnedProjectPaths = [],
	}: {
		controller: TicketsController;
		draft: TicketDraftState;
		chats: readonly TicketChatSummary[];
		username: string;
		onSubmit: () => void;
		onRefinementPendingChange: (pending: boolean) => void;
		active?: boolean;
		pinnedProjectPaths?: string[];
	} = $props();
	function keydown(event: KeyboardEvent) {
		if (
			isTicketSubmitKey(
				event,
				draft.current.kind === 'create' &&
					event.target instanceof HTMLInputElement &&
					event.target.classList.contains('ticket-title-input'),
			)
		) {
			event.preventDefault();
			onSubmit();
		}
	}
</script>

<fieldset disabled={!draft.canEdit} class="ticket-fields">
	<label class="ticket-field"
		>{m.tickets_title_field()}
		<input
			class="ticket-input ticket-title-input"
			value={draft.field('title')}
			maxlength={480}
			onkeydown={keydown}
			data-ticket-focus={JSON.stringify({
				kind: 'draft',
				draftId: draft.current.id,
				field: 'title',
			})}
			data-draft-version={draft.current.version}
			oninput={(event) => draft.setField('title', event.currentTarget.value)}
			required
		/>
	</label>
	<TicketTextEditor
		kind="description"
		{draft}
		{active}
		onkeydown={keydown}
		onPendingChange={onRefinementPendingChange}
	/>
	<div class="ticket-project-editor">
		<TicketProjectInput
			{controller}
			value={draft.field('project')}
			disabled={!draft.canEdit}
			onChange={(value) => draft.setField('project', value)}
			onKeydown={keydown}
		/>
		{#if draft.current.kind === 'create'}
			<p class="ticket-muted">{m.tickets_project_hint()}</p>
			<ProjectPinnedPathList
				{pinnedProjectPaths}
				selectedPath={draft.field('project')}
				disabled={!draft.canEdit}
				onSelect={(path) => draft.setField('project', path)}
			/>
		{/if}
	</div>
	<details open={draft.current.kind !== 'create'}>
		<summary>{m.tickets_more_details()}</summary>
		<div class="ticket-properties">
			<label class="ticket-field"
				>{m.tickets_priority()}<select
					class="ticket-input"
					onkeydown={keydown}
					value={draft.field('priority') || '2'}
					onchange={(event) => draft.setField('priority', event.currentTarget.value)}
				>
					{#each [0, 1, 2, 3] as priority (priority)}<option value={String(priority)}
							>{ticketPriorityLabel(priority as TicketPriority)}</option
						>{/each}
				</select></label
			>
			<label class="ticket-field"
				>{m.tickets_assignee()}<select
					class="ticket-input"
					onkeydown={keydown}
					value={draft.field('assignee')}
					onchange={(event) => draft.setField('assignee', event.currentTarget.value)}
				>
					<option value="">{m.tickets_unassigned()}</option><option value={`user:${username}`}
						>{m.tickets_me()}</option
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
							>{m.tickets_deleted_chat({ id: draft.field('assignee').slice(5) })}</option
						>{/if}
				</select></label
			>
			<label class="ticket-field"
				>{m.tickets_parent()}<input
					class="ticket-input"
					placeholder="G-42"
					value={draft.field('parentId')}
					onkeydown={keydown}
					oninput={(event) => draft.setField('parentId', event.currentTarget.value)}
				/></label
			>
			<TicketLabelsInput {controller} {draft} onKeydown={keydown} />
		</div>
	</details>
</fieldset>
