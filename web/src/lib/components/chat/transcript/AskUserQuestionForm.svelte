<script lang="ts">
	import type { AskUserQuestionToolUseMessage } from '$shared/chat-types';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import type { PermissionTerminalState } from '$lib/chat/transcript/conversation-feed-items.js';
	import type { PermissionQuestionDraft } from './ConversationFeedItemState.svelte.js';
	import QuestionForm from './QuestionForm.svelte';

	interface Props {
		tool: AskUserQuestionToolUseMessage;
		permissionOccurrenceId: string;
		isPending: boolean;
		canAnswer: boolean;
		terminal?: PermissionTerminalState;
		draft: PermissionQuestionDraft;
		onDraftChange: (draft: PermissionQuestionDraft) => void;
		onDecision: (decision: PermissionDecisionPayload) => void;
		composer?: boolean;
		onDismiss?: () => void;
	}
	let {
		tool,
		permissionOccurrenceId,
		isPending,
		canAnswer,
		terminal,
		draft,
		onDraftChange,
		onDecision,
		composer = false,
		onDismiss,
	}: Props = $props();
	const displayedDraft = $derived(
		terminal
			? {
					selectedQuestionOptions: terminal.selectedQuestionOptions ?? {},
					questionTextAnswers: terminal.questionTextAnswers ?? {},
				}
			: draft,
	);
</script>

<QuestionForm
	questions={tool.questions}
	formId={permissionOccurrenceId}
	{isPending}
	{canAnswer}
	{composer}
	{onDismiss}
	draft={displayedDraft}
	reason={terminal?.reason}
	submitClass="border-status-warning-border bg-status-warning text-status-warning-foreground hover:bg-status-warning/90"
	onDraftChange={(next) => onDraftChange({ ...draft, ...next })}
	onSubmit={(answers) =>
		onDecision({
			allow: true,
			response: { type: 'ask-user-question-response', outcome: 'answered', answers },
		})}
	onSkip={() =>
		onDecision({
			allow: false,
			response: {
				type: 'ask-user-question-response',
				outcome: 'skipped',
				reason: 'User skipped question',
			},
		})}
/>
