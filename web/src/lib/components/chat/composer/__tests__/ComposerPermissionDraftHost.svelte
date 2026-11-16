<script lang="ts">
	import type { ComposerQuestion } from '$lib/chat/composer/composer-question.js';
	import type { AsyncQuestionPanelPort } from '$lib/chat/conversation/async-question-context.js';
	import { ConversationFeedItemState } from '../../transcript/ConversationFeedItemState.svelte.js';
	import AskUserQuestionForm from '../../transcript/AskUserQuestionForm.svelte';
	import ComposerQuestionDock from '../ComposerQuestionDock.svelte';
	let { question, asyncPanel }: { question: Extract<ComposerQuestion, { kind: 'permission' }>; asyncPanel: AsyncQuestionPanelPort } = $props();
	const itemState = new ConversationFeedItemState();
	let dismissed = $state(false);
	const occurrence = $derived(question.request.permissionOccurrenceId);
</script>

{#if dismissed}
	<AskUserQuestionForm tool={question.request.requestedTool} permissionOccurrenceId={occurrence}
		isPending={true} canAnswer={true} draft={itemState.permissionDraft(occurrence)}
		onDraftChange={draft => itemState.setPermissionDraft(occurrence, draft)} onDecision={() => {}} />
{:else}
	<ComposerQuestionDock {question} {asyncPanel} identity="permission" canAnswer={true}
		permissionDraft={itemState.permissionDraft(occurrence)}
		onPermissionDraftChange={draft => itemState.setPermissionDraft(occurrence, draft)}
		onDismiss={() => dismissed = true} onDecision={() => {}} onSubmit={async () => false} />
{/if}
