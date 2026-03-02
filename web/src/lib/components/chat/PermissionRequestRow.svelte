<script lang="ts">
	// Renders a permission request inline in the message list. Shows
	// pending/resolved/cancelled state via ChatEventCard status variants.

	import type { PermissionRequestMessage } from '$shared/chat-types';
	import * as m from '$lib/paraglide/messages.js';
	import { ShieldAlert, FileCode, ChevronDown, Check, X } from '@lucide/svelte';
	import ChatEventCard from './rows/ChatEventCard.svelte';
	import Markdown from './Markdown.svelte';
	import type { MarkdownLinkNavigateEvent } from './Markdown.svelte';
	import { parseFileLink } from '$lib/chat/file-link-parser';
	import { getChatSessions, getFileViewer, getAppShell } from '$lib/context';

	type PlanExitChoice = 'bypass-new' | 'bypass' | 'approve-edits' | 'deny';

	interface PermissionTerminal {
		state: 'resolved' | 'cancelled';
		allowed?: boolean;
		reason?: string;
	}

	interface Props {
		request: PermissionRequestMessage;
		terminal?: PermissionTerminal;
		onDecision: (permissionRequestId: string, decision: { allow: boolean; message?: string }) => void;
		onExitPlanMode?: (permissionRequestId: string, choice: PlanExitChoice, plan: string) => void;
	}

	let { request, terminal, onDecision, onExitPlanMode }: Props = $props();

	const sessions = getChatSessions();
	const fileViewer = getFileViewer();
	const appShell = getAppShell();

	const projectBasePath = $derived(appShell.projectBasePath);
	const chatProjectPath = $derived(sessions.selectedChat?.projectPath ?? null);
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
		const chat = sessions.selectedChat;
		if (!chat) return;
		const parsed = parseFileLink(link.rawHref, { projectBasePath: chat.projectPath });
		if (parsed.kind !== 'file') return;
		fileViewer.openAuto({
			chatId: chat.id,
			projectPath: chat.projectPath,
			relativePath: parsed.relativePath,
			source: 'markdown-link',
			line: parsed.line,
			col: parsed.col,
		});
		return true;
	}

	function isExitPlanMode(toolName: string): boolean {
		return toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode';
	}

	function formatInput(input: unknown): string {
		if (!input) return '';
		if (typeof input === 'string') return input;
		return JSON.stringify(input, null, 2);
	}

	function getPlanContent(input: unknown): string {
		if (!input || typeof input !== 'object') return '';
		const record = input as Record<string, unknown>;
		const raw = record.plan ?? record.content ?? '';
		return String(raw).replace(/\\n/g, '\n');
	}

	function getAllowedPrompts(input: unknown): Array<Record<string, unknown>> {
		if (!input || typeof input !== 'object') return [];
		const record = input as Record<string, unknown>;
		if (!Array.isArray(record.allowedPrompts)) return [];
		return record.allowedPrompts as Array<Record<string, unknown>>;
	}

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

	const rawInput = $derived(formatInput(request.toolInput));
</script>

{#if isExitPlanMode(request.toolName)}
	{@const plan = getPlanContent(request.toolInput)}
	{@const prompts = getAllowedPrompts(request.toolInput)}

	<ChatEventCard variant={planCardVariant} class={resolvedOpacity}>
		{#snippet header()}
			<div class="flex items-center gap-2">
				<div class="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-current/25">
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
					<div class="px-2.5 py-1 bg-muted/50 border-b border-border/60 text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
						{m.chat_permission_plan()}
					</div>
					<div class="px-3 py-2.5 text-xs text-foreground leading-relaxed">
						<Markdown source={plan} {projectBasePath} onLinkNavigate={handleLinkNavigate} />
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
							<div class="flex items-center gap-2 text-[11px] font-mono bg-background/60 rounded-lg px-2.5 py-1.5 border border-border/40">
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
						title="Creates a new session with a clean context to implement the plan"
					>
						{m.chat_permission_yes_new_session_bypass()}
					</button>
					<button
						type="button"
						onclick={() => onExitPlanMode?.(request.permissionRequestId, 'bypass', plan)}
						class="inline-flex items-center gap-1.5 rounded-md text-xs font-medium px-3 py-1.5 transition-colors border border-status-warning-border text-status-warning hover:bg-status-warning/15"
						title="Continue in this session with bypass permissions"
					>
						{m.chat_permission_yes_bypass()}
					</button>
					<button
						type="button"
						onclick={() => onExitPlanMode?.(request.permissionRequestId, 'approve-edits', plan)}
						class="inline-flex items-center gap-1.5 rounded-md text-xs font-medium px-3 py-1.5 transition-colors border border-status-info-border text-status-info hover:bg-status-info/15"
						title="Continue in this session, manually approve edits"
					>
						{m.chat_permission_yes_approve_edits()}
					</button>
					<button
						type="button"
						onclick={() => onDecision(request.permissionRequestId, { allow: false, message: 'Keep in plan mode -- revise the plan based on feedback' })}
						class="inline-flex items-center gap-1.5 rounded-md text-xs font-medium px-3 py-1.5 transition-colors border border-status-info-border text-status-info hover:bg-status-info/15"
						title="Stay in plan mode -- type feedback to revise the plan"
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

{:else}
	<ChatEventCard variant={permCardVariant} class={resolvedOpacity}>
		{#snippet header()}
			<div class="flex items-center gap-2">
				<div class="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-current/25">
					<FileCode class="w-4 h-4" />
				</div>
				<div>
					<div class="text-sm font-semibold">
						{permTitle}
					</div>
					<div class="text-xs opacity-80">
						Tool: <span class="font-mono">{request.toolName}</span>
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
					<pre class="mt-2 max-h-40 overflow-auto rounded-md border border-current/20 bg-background/50 p-2 text-xs font-mono whitespace-pre-wrap">{rawInput}</pre>
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
						onclick={() => onDecision(request.permissionRequestId, { allow: false, message: 'User denied tool use' })}
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
