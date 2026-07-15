<script lang="ts">
	// Renders a permission request inline in the message list. Shows
	// pending/resolved/cancelled state via ChatEventCard status variants.

	import type {
		AskUserQuestionPrompt,
		CursorAskQuestionPrompt,
		CursorPlanTodoStatus,
		PermissionRequestMessage,
	} from '$shared/chat-types';
	import type {
		AskUserQuestionDecisionResponse,
		PermissionDecisionPayload,
	} from '$shared/chat-command-contracts';
	import type { ConversationMessageChatContext } from '$lib/chat/conversation-message-context';
	import type { PermissionTerminalState } from '$lib/chat/conversation-feed-items';
	import { getToolDisplayDetails, getToolDisplayLabel } from '$lib/chat/tool-display-registry';
	import * as m from '$lib/paraglide/messages.js';
	import { ShieldAlert, FileCode, ChevronDown, Check, X } from '@lucide/svelte';
	import ChatEventCard from './rows/ChatEventCard.svelte';
	import Markdown from './Markdown.svelte';
	import type { MarkdownLinkNavigateEvent } from './Markdown.svelte';
	import { resolveFileLinkTarget } from '$lib/chat/file-link-resolver';
	import { getChatSessions, getFileSessions, getAppShell } from '$lib/context';

	type PlanExitChoice = 'bypass-new' | 'bypass' | 'approve-edits' | 'deny';

	interface Props {
		request: PermissionRequestMessage;
		terminal?: PermissionTerminalState;
		onDecision: (
			permissionRequestId: string,
			decision: PermissionDecisionPayload & { message?: string },
		) => void;
		onExitPlanMode?: (permissionRequestId: string, choice: PlanExitChoice, plan: string) => void;
		chatContext?: ConversationMessageChatContext | null;
	}

	let { request, terminal, onDecision, onExitPlanMode, chatContext = null }: Props = $props();

	const sessions = getChatSessions();
	const fileSessions = getFileSessions();
	const appShell = getAppShell();

	const projectBasePath = $derived(appShell.projectBasePath);
	const activeChatContext = $derived.by((): ConversationMessageChatContext | null => {
		if (chatContext?.chatId) return chatContext;
		const selected = sessions.selectedChat;
		if (!selected?.id) return null;
		return { chatId: selected.id, projectPath: selected.projectPath ?? null };
	});
	const chatProjectPath = $derived(activeChatContext?.projectPath ?? null);
	const isPending = $derived(!terminal);
	const isResolved = $derived(terminal?.state === 'resolved');
	const isCancelled = $derived(terminal?.state === 'cancelled');
	const wasAllowed = $derived(isResolved && terminal?.allowed === true);

	type CardVariant = 'info' | 'success' | 'warning' | 'error' | 'neutral';

	// Maps lifecycle state to ChatEventCard variant for plan-mode rows.
	const planCardVariant = $derived.by((): CardVariant => {
		if (isPending) return 'info';
		if (wasAllowed) return 'success';
		if (isResolved) return 'error';
		return 'neutral';
	});

	// Maps lifecycle state to ChatEventCard variant for standard permission rows.
	const permCardVariant = $derived.by((): CardVariant => {
		if (isPending) return 'warning';
		if (wasAllowed) return 'success';
		if (isResolved) return 'error';
		return 'neutral';
	});

	const resolvedOpacity = $derived(!isPending ? 'opacity-75' : '');

	function handleLinkNavigate(link: MarkdownLinkNavigateEvent): boolean | void {
		if (link.kind !== 'file') return;
		const chat = activeChatContext;
		if (!chat?.projectPath) return;
		const resolved = resolveFileLinkTarget(link.rawHref, {
			projectBasePath,
			chatProjectPath: chat.projectPath,
		});
		if (!resolved) return;
		void fileSessions.open({
			fileRootPath: resolved.fileRootPath,
			relativePath: resolved.relativePath,
			mode: 'auto',
			reason: 'user-open',
			line: resolved.line,
			col: resolved.col,
		});
		return true;
	}

	const isExitPlanMode = $derived(request.requestedTool.type === 'exit-plan-mode-tool-use');
	const isAskUserQuestion = $derived(request.requestedTool.type === 'ask-user-question-tool-use');
	const isCursorAskQuestion = $derived(
		request.requestedTool.type === 'cursor-ask-question-tool-use',
	);
	const isCursorCreatePlan = $derived(request.requestedTool.type === 'cursor-create-plan-tool-use');

	const exitPlanRequest = $derived(
		request.requestedTool.type === 'exit-plan-mode-tool-use' ? request.requestedTool : null,
	);
	const askUserQuestionRequest = $derived(
		request.requestedTool.type === 'ask-user-question-tool-use' ? request.requestedTool : null,
	);
	const cursorAskQuestionRequest = $derived(
		request.requestedTool.type === 'cursor-ask-question-tool-use' ? request.requestedTool : null,
	);
	const cursorCreatePlanRequest = $derived(
		request.requestedTool.type === 'cursor-create-plan-tool-use' ? request.requestedTool : null,
	);

	const plan = $derived(exitPlanRequest ? exitPlanRequest.plan.replace(/\\n/g, '\n') : '');

	const prompts = $derived(exitPlanRequest?.allowedPrompts ?? []);

	const toolLabel = $derived(getToolDisplayLabel(request.requestedTool));
	const rawInput = $derived(JSON.stringify(getToolDisplayDetails(request.requestedTool), null, 2));

	const planTitle = $derived.by(() => {
		if (isPending) return m.chat_permission_plan_ready();
		if (wasAllowed) return m.chat_permission_plan_approved();
		if (isResolved) return m.chat_permission_plan_denied();
		return m.chat_permission_plan_cancelled();
	});

	const permTitle = $derived.by(() => {
		if (isPending) return m.chat_permission_permission_required();
		if (wasAllowed) return m.chat_permission_permission_allowed();
		if (isResolved) return m.chat_permission_permission_denied();
		return m.chat_permission_permission_cancelled();
	});

	let selectedQuestionOptions = $state<Record<string, string[]>>({});
	const terminalQuestionOptions = $derived(terminal?.selectedQuestionOptions ?? {});

	const canAnswerAskUserQuestion = $derived.by(() => {
		const questions = askUserQuestionRequest?.questions ?? [];
		if (questions.length === 0) return true;
		return questions.every((question) => {
			if (question.options.length === 0) return true;
			return (selectedQuestionOptions[question.id] ?? []).length > 0;
		});
	});

	const canAnswerCursorQuestion = $derived.by(() => {
		const questions = cursorAskQuestionRequest?.questions ?? [];
		if (questions.length === 0) return true;
		return questions.every((question) => {
			if (question.options.length === 0) return true;
			return (selectedQuestionOptions[question.id] ?? []).length > 0;
		});
	});

	const cursorPlanTitle = $derived.by(() => {
		if (isPending) return m.chat_permission_cursor_plan_ready();
		if (wasAllowed) return m.chat_permission_cursor_plan_approved();
		if (isResolved) return m.chat_permission_cursor_plan_rejected();
		return m.chat_permission_plan_cancelled();
	});

	const askUserQuestionTitle = $derived.by(() => {
		if (isPending)
			return askUserQuestionRequest?.title || m.chat_permission_cursor_question_required();
		if (wasAllowed) return m.chat_permission_cursor_question_answered();
		if (isResolved) return m.chat_permission_cursor_question_skipped();
		return m.chat_permission_permission_cancelled();
	});

	const cursorQuestionTitle = $derived.by(() => {
		if (isPending)
			return cursorAskQuestionRequest?.title || m.chat_permission_cursor_question_required();
		if (wasAllowed) return m.chat_permission_cursor_question_answered();
		if (isResolved) return m.chat_permission_cursor_question_skipped();
		return m.chat_permission_permission_cancelled();
	});

	function selectedOptionsFor(questionId: string): string[] {
		return terminalQuestionOptions[questionId] ?? selectedQuestionOptions[questionId] ?? [];
	}

	function isOptionSelected(questionId: string, optionId: string): boolean {
		return selectedOptionsFor(questionId).includes(optionId);
	}

	function updateAskUserQuestionOption(
		question: AskUserQuestionPrompt,
		optionId: string,
		checked: boolean,
	): void {
		if (question.allowMultiple) {
			const current = new Set(selectedOptionsFor(question.id));
			if (checked) current.add(optionId);
			else current.delete(optionId);
			selectedQuestionOptions[question.id] = Array.from(current);
			return;
		}
		selectedQuestionOptions[question.id] = checked ? [optionId] : [];
	}

	function selectedQuestionPreview(question: AskUserQuestionPrompt): string | undefined {
		const selected = selectedOptionsFor(question.id);
		const option = question.options.find((candidate) => selected.includes(candidate.id));
		return option?.preview;
	}

	function askUserQuestionResponse(
		outcome: 'answered' | 'skipped',
	): AskUserQuestionDecisionResponse {
		if (outcome === 'skipped') {
			return {
				type: 'ask-user-question-response',
				outcome: 'skipped',
				reason: 'User skipped question',
			};
		}
		return {
			type: 'ask-user-question-response',
			outcome: 'answered',
			answers: (askUserQuestionRequest?.questions ?? []).map((question) => ({
				questionId: question.id,
				selectedOptionIds: selectedOptionsFor(question.id),
			})),
		};
	}

	function respondToAskUserQuestion(outcome: 'answered' | 'skipped'): void {
		onDecision(request.permissionRequestId, {
			allow: outcome === 'answered',
			response: askUserQuestionResponse(outcome),
		});
	}

	function updateQuestionOption(
		question: CursorAskQuestionPrompt,
		optionId: string,
		checked: boolean,
	): void {
		if (question.allowMultiple) {
			const current = new Set(selectedOptionsFor(question.id));
			if (checked) current.add(optionId);
			else current.delete(optionId);
			selectedQuestionOptions[question.id] = Array.from(current);
			return;
		}
		selectedQuestionOptions[question.id] = checked ? [optionId] : [];
	}

	function cursorQuestionResponse(outcome: 'answered' | 'skipped'): Record<string, unknown> {
		if (outcome === 'skipped') {
			return { outcome: { outcome: 'skipped', reason: 'User skipped question' } };
		}
		return {
			outcome: {
				outcome: 'answered',
				answers: (cursorAskQuestionRequest?.questions ?? []).map((question) => ({
					questionId: question.id,
					selectedOptionIds: selectedOptionsFor(question.id),
				})),
			},
		};
	}

	function respondToCursorQuestion(outcome: 'answered' | 'skipped'): void {
		onDecision(request.permissionRequestId, {
			allow: outcome === 'answered',
			response: cursorQuestionResponse(outcome),
		});
	}

	function cursorPlanResponse(outcome: 'accepted' | 'rejected'): Record<string, unknown> {
		if (outcome === 'accepted') return { outcome: { outcome: 'accepted' } };
		return { outcome: { outcome: 'rejected', reason: 'User rejected plan' } };
	}

	function respondToCursorPlan(outcome: 'accepted' | 'rejected'): void {
		onDecision(request.permissionRequestId, {
			allow: outcome === 'accepted',
			response: cursorPlanResponse(outcome),
		});
	}

	function todoStatusLabel(status: CursorPlanTodoStatus): string {
		switch (status) {
			case 'completed':
				return m.chat_permission_status_completed();
			case 'in_progress':
				return m.chat_permission_status_in_progress();
			case 'cancelled':
				return m.chat_permission_status_cancelled();
			default:
				return m.chat_permission_status_pending();
		}
	}
</script>

{#if isExitPlanMode}
	<ChatEventCard variant={planCardVariant} class={resolvedOpacity}>
		{#snippet header()}
			<div class="flex items-center gap-2">
				<div
					class="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-current/25"
				>
					<ShieldAlert class="w-4 h-4" />
				</div>
				<span class="text-sm font-semibold">
					{planTitle}
				</span>
			</div>
		{/snippet}

		{#snippet body()}
			{#if plan}
				<div class="rounded-lg border border-border/60 overflow-hidden mb-2">
					<div
						class="px-2.5 py-1 bg-muted/50 border-b border-border/60 text-[10px] text-muted-foreground font-mono uppercase tracking-wider"
					>
						{m.chat_permission_plan()}
					</div>
					<div class="px-3 py-2.5 text-xs text-foreground leading-relaxed">
						<Markdown
							source={plan}
							fileLinkBasePath={projectBasePath}
							onLinkNavigate={handleLinkNavigate}
						/>
					</div>
				</div>
			{/if}

			{#if prompts.length > 0}
				<div class="mb-2">
					<div class="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
						{m.chat_permission_requested_permissions()}
					</div>
					<div class="space-y-1">
						{#each prompts as prompt, i (i)}
							<div
								class="flex items-center gap-2 text-[11px] font-mono bg-background/60 rounded-lg px-2.5 py-1.5 border border-border/40"
							>
								<span class="text-muted-foreground shrink-0">
									{String(prompt.tool || '')}
								</span>
								<span class="text-foreground">
									{String(prompt.prompt || '')}
								</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			{#if !plan && prompts.length === 0}
				<div class="text-xs text-muted-foreground mb-2">
					{m.chat_permission_plan_approval()}
				</div>
			{/if}
		{/snippet}

		{#snippet footer()}
			{#if isPending}
				<div class="flex flex-wrap items-center gap-2">
					<button
						type="button"
						onclick={() => onExitPlanMode?.(request.permissionRequestId, 'bypass-new', plan)}
						class="inline-flex items-center gap-1.5 rounded-md text-xs font-medium px-3 py-1.5 transition-colors border border-status-warning-border bg-status-warning text-status-warning-foreground hover:bg-status-warning/90"
						title={m.chat_permission_tooltip_new_session_bypass()}
					>
						{m.chat_permission_yes_new_session_bypass()}
					</button>
					<button
						type="button"
						onclick={() => onExitPlanMode?.(request.permissionRequestId, 'bypass', plan)}
						class="inline-flex items-center gap-1.5 rounded-md text-xs font-medium px-3 py-1.5 transition-colors border border-status-warning-border text-status-warning hover:bg-status-warning/15"
						title={m.chat_permission_tooltip_bypass()}
					>
						{m.chat_permission_yes_bypass()}
					</button>
					<button
						type="button"
						onclick={() => onExitPlanMode?.(request.permissionRequestId, 'approve-edits', plan)}
						class="inline-flex items-center gap-1.5 rounded-md text-xs font-medium px-3 py-1.5 transition-colors border border-status-info-border text-status-info hover:bg-status-info/15"
						title={m.chat_permission_tooltip_approve_edits()}
					>
						{m.chat_permission_yes_approve_edits()}
					</button>
					<button
						type="button"
						onclick={() =>
							onDecision(request.permissionRequestId, {
								allow: false,
								message: m.chat_permission_revise_plan_message(),
							})}
						class="inline-flex items-center gap-1.5 rounded-md text-xs font-medium px-3 py-1.5 transition-colors border border-status-info-border text-status-info hover:bg-status-info/15"
						title={m.chat_permission_tooltip_revise_plan()}
					>
						{m.chat_permission_revise_plan()}
					</button>
					<button
						type="button"
						onclick={() => onExitPlanMode?.(request.permissionRequestId, 'deny', plan)}
						class="inline-flex items-center gap-1.5 rounded-md text-xs font-medium px-3 py-1.5 transition-colors border border-status-neutral-border text-status-neutral-foreground hover:bg-status-neutral/50"
					>
						<X class="w-3.5 h-3.5" />
						{m.chat_permission_deny()}
					</button>
				</div>
			{/if}
		{/snippet}
	</ChatEventCard>
{:else if isAskUserQuestion}
	<ChatEventCard variant={permCardVariant} class={resolvedOpacity}>
		{#snippet header()}
			<div class="flex items-center gap-2">
				<div
					class="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-current/25"
				>
					<ShieldAlert class="w-4 h-4" />
				</div>
				<span class="text-sm font-semibold">
					{askUserQuestionTitle}
				</span>
			</div>
		{/snippet}

		{#snippet body()}
			{#if askUserQuestionRequest && askUserQuestionRequest.questions.length > 0}
				<div class="space-y-3">
					{#each askUserQuestionRequest.questions as question (question.id)}
						<div class="space-y-2">
							<div class="space-y-1">
								{#if question.header}
									<div
										class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
									>
										{question.header}
									</div>
								{/if}
								<div class="text-xs font-medium text-foreground">{question.prompt}</div>
							</div>
							<div class="grid gap-1.5">
								{#each question.options as option (option.id)}
									<label
										class="flex items-start gap-2 rounded-md border border-border/60 bg-background/50 px-2.5 py-1.5 text-xs text-foreground"
									>
										<input
											type={question.allowMultiple ? 'checkbox' : 'radio'}
											name={`${request.permissionRequestId}-${question.id}`}
											checked={isOptionSelected(question.id, option.id)}
											disabled={!isPending}
											onchange={(event) =>
												updateAskUserQuestionOption(
													question,
													option.id,
													(event.currentTarget as HTMLInputElement).checked,
												)}
											class="mt-0.5 size-3.5 accent-current"
										/>
										<span class="min-w-0 space-y-0.5">
											<span class="block font-medium">{option.label}</span>
											{#if option.description}
												<span class="block text-muted-foreground">{option.description}</span>
											{/if}
										</span>
									</label>
								{/each}
							</div>
							{#if selectedQuestionPreview(question)}
								<pre
									class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/40 p-2 text-[11px] text-foreground">{selectedQuestionPreview(
										question,
									)}</pre>
							{/if}
						</div>
					{/each}
				</div>
			{:else}
				<div class="text-xs text-muted-foreground">
					{m.chat_permission_cursor_question_required()}
				</div>
			{/if}
		{/snippet}

		{#snippet footer()}
			{#if isPending}
				<div class="flex flex-wrap gap-2">
					<button
						type="button"
						disabled={!canAnswerAskUserQuestion}
						onclick={() => respondToAskUserQuestion('answered')}
						class="inline-flex items-center gap-1.5 rounded-md border border-status-warning-border bg-status-warning text-status-warning-foreground text-xs font-medium px-3 py-1.5 hover:bg-status-warning/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						<Check class="w-3.5 h-3.5" />
						{m.chat_permission_submit_answer()}
					</button>
					<button
						type="button"
						onclick={() => respondToAskUserQuestion('skipped')}
						class="inline-flex items-center gap-1.5 rounded-md text-xs font-medium px-3 py-1.5 border border-status-error-border text-status-error-foreground hover:bg-status-error/20 transition-colors"
					>
						<X class="w-3.5 h-3.5" />
						{m.chat_permission_skip()}
					</button>
				</div>
			{/if}
		{/snippet}
	</ChatEventCard>
{:else if isCursorAskQuestion}
	<ChatEventCard variant={permCardVariant} class={resolvedOpacity}>
		{#snippet header()}
			<div class="flex items-center gap-2">
				<div
					class="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-current/25"
				>
					<ShieldAlert class="w-4 h-4" />
				</div>
				<span class="text-sm font-semibold">
					{cursorQuestionTitle}
				</span>
			</div>
		{/snippet}

		{#snippet body()}
			{#if cursorAskQuestionRequest && cursorAskQuestionRequest.questions.length > 0}
				<div class="space-y-3">
					{#each cursorAskQuestionRequest.questions as question (question.id)}
						<div class="space-y-2">
							<div class="text-xs font-medium text-foreground">{question.prompt}</div>
							<div class="grid gap-1.5">
								{#each question.options as option (option.id)}
									<label
										class="flex items-center gap-2 rounded-md border border-border/60 bg-background/50 px-2.5 py-1.5 text-xs text-foreground"
									>
										<input
											type={question.allowMultiple ? 'checkbox' : 'radio'}
											name={`${request.permissionRequestId}-${question.id}`}
											checked={isOptionSelected(question.id, option.id)}
											disabled={!isPending}
											onchange={(event) =>
												updateQuestionOption(
													question,
													option.id,
													(event.currentTarget as HTMLInputElement).checked,
												)}
											class="size-3.5 accent-current"
										/>
										<span>{option.label}</span>
									</label>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			{:else}
				<div class="text-xs text-muted-foreground">
					{m.chat_permission_cursor_question_required()}
				</div>
			{/if}
		{/snippet}

		{#snippet footer()}
			{#if isPending}
				<div class="flex flex-wrap gap-2">
					<button
						type="button"
						disabled={!canAnswerCursorQuestion}
						onclick={() => respondToCursorQuestion('answered')}
						class="inline-flex items-center gap-1.5 rounded-md border border-status-warning-border bg-status-warning text-status-warning-foreground text-xs font-medium px-3 py-1.5 hover:bg-status-warning/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						<Check class="w-3.5 h-3.5" />
						{m.chat_permission_submit_answer()}
					</button>
					<button
						type="button"
						onclick={() => respondToCursorQuestion('skipped')}
						class="inline-flex items-center gap-1.5 rounded-md text-xs font-medium px-3 py-1.5 border border-status-error-border text-status-error-foreground hover:bg-status-error/20 transition-colors"
					>
						<X class="w-3.5 h-3.5" />
						{m.chat_permission_skip()}
					</button>
				</div>
			{/if}
		{/snippet}
	</ChatEventCard>
{:else if isCursorCreatePlan}
	<ChatEventCard variant={planCardVariant} class={resolvedOpacity}>
		{#snippet header()}
			<div class="flex items-center gap-2">
				<div
					class="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-current/25"
				>
					<ShieldAlert class="w-4 h-4" />
				</div>
				<span class="text-sm font-semibold">
					{cursorPlanTitle}
				</span>
			</div>
		{/snippet}

		{#snippet body()}
			{#if cursorCreatePlanRequest}
				<div class="space-y-2">
					{#if cursorCreatePlanRequest.name || cursorCreatePlanRequest.overview}
						<div class="space-y-1">
							{#if cursorCreatePlanRequest.name}
								<div class="text-sm font-semibold text-foreground">
									{cursorCreatePlanRequest.name}
								</div>
							{/if}
							{#if cursorCreatePlanRequest.overview}
								<div class="text-xs text-muted-foreground">
									{cursorCreatePlanRequest.overview}
								</div>
							{/if}
						</div>
					{/if}

					{#if cursorCreatePlanRequest.plan}
						<div class="rounded-lg border border-border/60 overflow-hidden">
							<div
								class="px-2.5 py-1 bg-muted/50 border-b border-border/60 text-[10px] text-muted-foreground font-mono uppercase tracking-wider"
							>
								{m.chat_permission_plan()}
							</div>
							<div class="px-3 py-2.5 text-xs text-foreground leading-relaxed">
								<Markdown
									source={cursorCreatePlanRequest.plan}
									fileLinkBasePath={projectBasePath}
									onLinkNavigate={handleLinkNavigate}
								/>
							</div>
						</div>
					{/if}

					{#if cursorCreatePlanRequest.todos && cursorCreatePlanRequest.todos.length > 0}
						<div class="space-y-1">
							<div class="text-[10px] text-muted-foreground uppercase tracking-wider">
								{m.chat_permission_todos()}
							</div>
							<div class="grid gap-1">
								{#each cursorCreatePlanRequest.todos as todo, i (todo.id ?? i)}
									<div
										class="flex items-start justify-between gap-2 rounded-md border border-border/50 bg-background/50 px-2.5 py-1.5 text-xs"
									>
										<span class="min-w-0 text-foreground">{todo.content}</span>
										<span class="shrink-0 text-muted-foreground"
											>{todoStatusLabel(todo.status)}</span
										>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					{#if cursorCreatePlanRequest.phases && cursorCreatePlanRequest.phases.length > 0}
						<div class="space-y-2">
							{#each cursorCreatePlanRequest.phases as phase (phase.name)}
								<div class="space-y-1">
									<div class="text-xs font-medium text-foreground">{phase.name}</div>
									<div class="grid gap-1">
										{#each phase.todos as todo, i (todo.id ?? i)}
											<div
												class="flex items-start justify-between gap-2 rounded-md border border-border/50 bg-background/50 px-2.5 py-1.5 text-xs"
											>
												<span class="min-w-0 text-foreground">{todo.content}</span>
												<span class="shrink-0 text-muted-foreground"
													>{todoStatusLabel(todo.status)}</span
												>
											</div>
										{/each}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		{/snippet}

		{#snippet footer()}
			{#if isPending}
				<div class="flex flex-wrap gap-2">
					<button
						type="button"
						onclick={() => respondToCursorPlan('accepted')}
						class="inline-flex items-center gap-1.5 rounded-md border border-status-warning-border bg-status-warning text-status-warning-foreground text-xs font-medium px-3 py-1.5 hover:bg-status-warning/90 transition-colors"
					>
						<Check class="w-3.5 h-3.5" />
						{m.chat_permission_accept_plan()}
					</button>
					<button
						type="button"
						onclick={() => respondToCursorPlan('rejected')}
						class="inline-flex items-center gap-1.5 rounded-md text-xs font-medium px-3 py-1.5 border border-status-error-border text-status-error-foreground hover:bg-status-error/20 transition-colors"
					>
						<X class="w-3.5 h-3.5" />
						{m.chat_permission_reject_plan()}
					</button>
				</div>
			{/if}
		{/snippet}
	</ChatEventCard>
{:else}
	<ChatEventCard variant={permCardVariant} class={resolvedOpacity}>
		{#snippet header()}
			<div class="flex items-center gap-2">
				<div
					class="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-current/25"
				>
					<FileCode class="w-4 h-4" />
				</div>
				<div>
					<div class="text-sm font-semibold">
						{permTitle}
					</div>
					<div class="text-xs opacity-80">
						Tool: <span class="font-mono">{toolLabel}</span>
					</div>
				</div>
			</div>
		{/snippet}

		{#snippet body()}
			{#if rawInput}
				<details class="mt-1">
					<summary class="cursor-pointer text-xs opacity-80 flex items-center gap-1 select-none">
						<ChevronDown class="w-3.5 h-3.5" />
						{m.chat_permission_view_tool_input()}
					</summary>
					<pre
						class="mt-2 max-h-40 overflow-auto rounded-md border border-current/20 bg-background/50 p-2 text-xs font-mono whitespace-pre-wrap">{rawInput}</pre>
				</details>
			{/if}
		{/snippet}

		{#snippet footer()}
			{#if isPending}
				<div class="flex flex-wrap gap-2">
					<button
						type="button"
						onclick={() => onDecision(request.permissionRequestId, { allow: true })}
						class="inline-flex items-center gap-1.5 rounded-md border border-status-warning-border bg-status-warning text-status-warning-foreground text-xs font-medium px-3 py-1.5 hover:bg-status-warning/90 transition-colors"
					>
						<Check class="w-3.5 h-3.5" />
						{m.chat_permission_allow_once()}
					</button>
					<button
						type="button"
						onclick={() =>
							onDecision(request.permissionRequestId, {
								allow: false,
								message: 'User denied tool use',
							})}
						class="inline-flex items-center gap-1.5 rounded-md text-xs font-medium px-3 py-1.5 border border-status-error-border text-status-error-foreground hover:bg-status-error/20 transition-colors"
					>
						<X class="w-3.5 h-3.5" />
						{m.chat_permission_deny()}
					</button>
				</div>
			{/if}
		{/snippet}
	</ChatEventCard>
{/if}
