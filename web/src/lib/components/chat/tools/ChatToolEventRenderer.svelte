<script lang="ts">
	import type { ToolUseChatMessage, TodoItem } from '$shared/chat-types';
	import {
		TOOL_DISPLAY_REGISTRY,
		getToolDisplayLabel,
		getToolDisplayPayload,
	} from '$lib/chat/tools/tool-display-registry.js';
	import { resolveDisplayRule } from '$lib/chat/tools/tool-display-policy.js';
	import type {
		ToolInputDisplayRule,
		ToolResultDisplayRule,
	} from '$lib/chat/tools/tool-display-contract.js';
	import ChatToolInlineEvent from './ChatToolInlineEvent.svelte';
	import ChatBashToolEvent from './ChatBashToolEvent.svelte';
	import ChatToolExpandableEvent from './ChatToolExpandableEvent.svelte';
	import ChatToolDiffView from './content/ChatToolDiffView.svelte';
	import ChatToolRichTextView from './content/ChatToolRichTextView.svelte';
	import ChatToolFileListView from './content/ChatToolFileListView.svelte';
	import ChatToolPlainTextView from './content/ChatToolPlainTextView.svelte';
	import ChatToolTodoListView from './content/ChatToolTodoListView.svelte';
	import CodeBlock from '../CodeBlock.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type {
		ConversationDisclosureKind,
		ConversationDisclosureStatePort,
	} from '../ConversationFeedItemState.svelte.js';

	interface ToolRendererProps {
		toolMessage: ToolUseChatMessage;
		toolResult?: Record<string, unknown>;
		mode: 'input' | 'result';
		resultAnchorId?: string;
		onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
		projectBasePath?: string | null;
		chatProjectPath?: string | null;
		autoExpandTools?: boolean;
		disclosureState?: ConversationDisclosureStatePort;
		acquireTransientActivity?: (close: () => void) => () => void;
	}

	let {
		toolMessage,
		toolResult,
		mode,
		resultAnchorId,
		onFileOpen,
		projectBasePath,
		chatProjectPath,
		autoExpandTools = false,
		disclosureState,
		acquireTransientActivity,
	}: ToolRendererProps = $props();

	const toolName = $derived(getToolDisplayLabel(toolMessage));
	const toolId = $derived(toolMessage.toolId);

	let config = $derived(resolveDisplayRule(TOOL_DISPLAY_REGISTRY, toolMessage.type));
	let displayConfig = $derived(mode === 'input' ? config.input : config.result);

	let parsedData = $derived(
		mode === 'input' ? getToolDisplayPayload(toolMessage) : (toolResult ?? {}),
	);

	function handleAction() {
		const cfg = displayConfig as ToolInputDisplayRule | undefined;
		if (cfg?.action === 'openFile' && onFileOpen) {
			const value = cfg.getValue?.(parsedData) || '';
			onFileOpen(value);
		}
	}

	let collapsibleTitle = $derived.by(() => {
		if (!displayConfig || displayConfig.mode !== 'collapsible') return '';
		return typeof displayConfig.title === 'function'
			? displayConfig.title(parsedData)
			: displayConfig.title || m.chat_tool_renderer_details();
	});

	let collapsibleDefaultOpen = $derived.by(() => {
		if (!displayConfig || displayConfig.mode !== 'collapsible') return false;
		if (autoExpandTools) return true;
		return displayConfig.defaultOpen ?? false;
	});

	let contentProps = $derived.by(() => {
		if (!displayConfig || displayConfig.mode !== 'collapsible') return {};
		return (
			displayConfig.getContentProps?.(parsedData, {
				projectPath: chatProjectPath,
				onFileOpen,
			}) || {}
		);
	});

	let shouldRenderCollapsedAsInline = $derived.by(() => {
		if (!displayConfig || displayConfig.mode !== 'collapsible') return false;
		if (displayConfig.contentKind !== 'diff') return false;
		if (!contentProps.diffUnavailable) return false;
		const files = (contentProps.files as string[] | undefined) || [];
		return files.length <= 1;
	});

	let collapsedInlineFilePath = $derived.by(() => {
		const files = (contentProps.files as string[] | undefined) || [];
		return files[0] || '';
	});

	let handleTitleClick = $derived.by(() => {
		if (
			(toolMessage.type === 'edit-tool-use' ||
				toolMessage.type === 'write-tool-use' ||
				toolMessage.type === 'apply-patch-tool-use') &&
			contentProps.filePath &&
			onFileOpen
		) {
			return () =>
				onFileOpen!(contentProps.filePath as string, {
					old_string: contentProps.oldContent,
					new_string: contentProps.newContent,
				});
		}
		return undefined;
	});

	let inlineValue = $derived.by(() => {
		if (!displayConfig || displayConfig.mode !== 'inline') return '';
		const cfg = displayConfig as ToolInputDisplayRule;
		return cfg.getValue?.(parsedData) || '';
	});

	let inlineSecondary = $derived.by(() => {
		if (!displayConfig || displayConfig.mode !== 'inline') return undefined;
		const cfg = displayConfig as ToolInputDisplayRule;
		return cfg.getSecondary?.(parsedData);
	});

	let inlineLabel = $derived.by(() => {
		if (!displayConfig || displayConfig.mode !== 'inline') return undefined;
		const cfg = displayConfig as ToolInputDisplayRule;
		return cfg.getLabel?.(parsedData) ?? cfg.label;
	});

	let inlineLanguage = $derived.by(() => {
		if (!displayConfig || displayConfig.mode !== 'inline') return undefined;
		const cfg = displayConfig as ToolInputDisplayRule;
		return cfg.getLanguage?.(parsedData) ?? cfg.language;
	});

	let successMessage = $derived.by(() => {
		if (!displayConfig || displayConfig.mode !== 'collapsible') return '';
		if (displayConfig.contentKind !== 'successMessage') return '';
		return (
			(displayConfig as ToolResultDisplayRule).getMessage?.(parsedData) ||
			m.chat_tool_renderer_success()
		);
	});

	let inputAnchorId = $derived(mode === 'input' ? `tool-input-${toolId}` : undefined);
	const disclosureKind: ConversationDisclosureKind = $derived(
		mode === 'input' ? 'tool-input' : 'tool-result',
	);
	let displayAnchorId = $derived(
		mode === 'input' ? inputAnchorId : (resultAnchorId ?? `tool-result-${toolId}`),
	);
	let displayOpen = $derived(
		disclosureState?.open(disclosureKind, toolId, collapsibleDefaultOpen),
	);
</script>

{#if mode === 'input' && toolMessage.type === 'bash-tool-use'}
	<ChatBashToolEvent command={toolMessage.command} anchorId={inputAnchorId} />
{:else if displayConfig && displayConfig.mode !== 'hidden' && displayConfig.mode !== 'special'}
	<div id={displayAnchorId} class="scroll-mt-16">
		{#if displayConfig.mode === 'inline'}
			{@const cfg = displayConfig as ToolInputDisplayRule}
			<ChatToolInlineEvent
				{toolName}
				{toolResult}
				label={inlineLabel}
				value={inlineValue}
				secondary={inlineSecondary}
				action={cfg.action}
				onAction={handleAction}
				style={cfg.style}
				wrapText={cfg.wrapText}
				language={inlineLanguage}
				colorScheme={cfg.colorScheme}
				resultId={mode === 'input' ? resultAnchorId : undefined}
			/>
		{:else if displayConfig.mode === 'collapsible'}
			{#if shouldRenderCollapsedAsInline}
				<ChatToolInlineEvent
					{toolName}
					{toolResult}
					label={toolName}
					value={collapsedInlineFilePath || collapsibleTitle}
					action={collapsedInlineFilePath && onFileOpen ? 'openFile' : 'none'}
					onAction={collapsedInlineFilePath && onFileOpen
						? () => onFileOpen(collapsedInlineFilePath)
						: undefined}
				/>
			{:else}
				<ChatToolExpandableEvent
					{toolName}
					{toolId}
					title={collapsibleTitle}
					defaultOpen={collapsibleDefaultOpen}
					open={displayOpen}
					onOpenChange={disclosureState
						? (open) =>
								disclosureState.setOpen(
									disclosureKind,
									toolId,
									open,
									collapsibleDefaultOpen,
								)
						: undefined}
					onTitleClick={handleTitleClick}
				>
					{#snippet children()}
						{#if displayConfig.contentKind === 'code'}
							<CodeBlock
								text={(contentProps.content as string) || ''}
								lang={(contentProps.language as string) || ''}
							/>
						{:else if displayConfig.contentKind === 'diff'}
							{#if contentProps.diffUnavailable}
								<ChatToolFileListView
									files={(contentProps.files as string[]) || []}
									onFileClick={onFileOpen}
									title={contentProps.title as string | undefined}
								/>
							{:else}
								<ChatToolDiffView
									oldContent={(contentProps.oldContent as string) || ''}
									newContent={(contentProps.newContent as string) || ''}
									filePath={(contentProps.filePath as string) || ''}
									showHeader={(contentProps.showHeader as boolean | undefined) ?? true}
									badge={contentProps.badge as string | undefined}
									badgeColor={contentProps.badgeColor as 'gray' | 'green' | undefined}
									onFileClick={contentProps.filePath && onFileOpen
										? () => onFileOpen?.(contentProps.filePath as string)
										: undefined}
								/>
							{/if}
						{:else if displayConfig.contentKind === 'markdown'}
							<ChatToolRichTextView
								content={(contentProps.content as string) || ''}
								{projectBasePath}
								{chatProjectPath}
								{onFileOpen}
								{acquireTransientActivity}
							/>
						{:else if displayConfig.contentKind === 'fileList'}
							<ChatToolFileListView
								files={(contentProps.files as string[]) || []}
								onFileClick={onFileOpen}
								title={contentProps.title as string | undefined}
							/>
						{:else if displayConfig.contentKind === 'text'}
							<ChatToolPlainTextView
								content={(contentProps.content as string) || ''}
								format={(contentProps.format as 'plain' | 'json' | 'code') || 'plain'}
								language={contentProps.language as string | undefined}
							/>
						{:else if displayConfig.contentKind === 'successMessage'}
							<div class="flex items-center gap-1.5 text-xs text-status-success-foreground">
								<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M5 13l4 4L19 7"
									/>
								</svg>
								{successMessage}
							</div>
						{:else if displayConfig.contentKind === 'todoList'}
							<ChatToolTodoListView todos={contentProps.todos as TodoItem[] | undefined} />
						{:else if displayConfig.contentKind === 'task'}
							<ChatToolPlainTextView
								content={(contentProps.content as string) || ''}
								format="plain"
							/>
						{/if}
					{/snippet}
				</ChatToolExpandableEvent>
			{/if}
		{/if}
	</div>
{/if}
