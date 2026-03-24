<script lang="ts">
	// Dispatches tool rendering to ChatToolInlineEvent or ChatToolExpandableEvent
	// based on the config-driven registry in tool-display-registry.ts.

	import type { ToolUseChatMessage, TodoItem } from '$shared/chat-types';
	import { toRenderToolPayload } from '$lib/chat/tool-render-payload';
	import { TOOL_DISPLAY_REGISTRY } from '$lib/chat/tool-display-registry';
	import { resolveDisplayRule } from '$lib/chat/tool-display-policy';
	import type { ToolInlineAction, ToolInputDisplayRule, ToolResultDisplayRule } from '$lib/chat/tool-display-contract';
	import ChatToolInlineEvent from './ChatToolInlineEvent.svelte';
	import ChatToolExpandableEvent from './ChatToolExpandableEvent.svelte';
	import ChatToolDiffView from './content/ChatToolDiffView.svelte';
	import ChatToolRichTextView from './content/ChatToolRichTextView.svelte';
	import ChatToolFileListView from './content/ChatToolFileListView.svelte';
	import ChatToolPlainTextView from './content/ChatToolPlainTextView.svelte';
	import ChatToolTodoListView from './content/ChatToolTodoListView.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface ToolRendererProps {
		toolMessage: ToolUseChatMessage;
		toolResult?: Record<string, unknown>;
		mode: 'input' | 'result';
		onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
		projectPath?: string | null;
		autoExpandTools?: boolean;
	}

	let {
		toolMessage,
		toolResult,
		mode,
		onFileOpen,
		projectPath,
		autoExpandTools = false
	}: ToolRendererProps = $props();

	const renderPayload = $derived(toRenderToolPayload(toolMessage));
	const toolName = $derived(renderPayload.name);
	const toolInput = $derived(renderPayload.input);
	const toolId = $derived(toolMessage.toolId);

	let config = $derived(resolveDisplayRule(TOOL_DISPLAY_REGISTRY, toolName));
	let displayConfig = $derived(mode === 'input' ? config.input : config.result);

	let parsedData = $derived.by(() => {
		try {
			const rawData = mode === 'input' ? toolInput : toolResult;
			return typeof rawData === 'string' ? JSON.parse(rawData as string) : rawData;
		} catch {
			return mode === 'input' ? toolInput : toolResult;
		}
	});

	function handleAction() {
		const cfg = displayConfig as ToolInputDisplayRule | undefined;
		if (cfg?.action === 'openFile' && onFileOpen) {
			const value = cfg.getValue?.(parsedData) || '';
			onFileOpen(value);
		}
	}

	// Collapsible config helpers
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
				projectPath,
				onFileOpen
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
			(toolName === 'Edit' || toolName === 'Write' || toolName === 'ApplyPatch') &&
			contentProps.filePath &&
			onFileOpen
		) {
			return () =>
				onFileOpen!(contentProps.filePath as string, {
					old_string: contentProps.oldContent,
					new_string: contentProps.newContent
				});
		}
		return undefined;
	});

	// Inline config helpers
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

	// Success message helper
	let successMessage = $derived.by(() => {
		if (!displayConfig || displayConfig.mode !== 'collapsible') return '';
		if (displayConfig.contentKind !== 'successMessage') return '';
		return (displayConfig as ToolResultDisplayRule).getMessage?.(parsedData) || m.chat_tool_renderer_success();
	});

	// Result rendering: when toolResult is available and the result config
	// specifies a renderable mode, render the result section with an id
	// so jumpToResult links have a valid scroll target.
	let resultConfig = $derived(config.result as ToolResultDisplayRule | undefined);

	let shouldRenderResult = $derived.by(() => {
		if (!toolResult || !resultConfig) return false;
		if (resultConfig.hidden) return false;
		if (resultConfig.mode === 'special') return false;
		if (resultConfig.hideOnSuccess && !toolResult.isError) return false;
		return resultConfig.mode === 'collapsible';
	});

	let parsedResultData = $derived.by(() => {
		if (!toolResult) return {};
		try {
			return typeof toolResult === 'string' ? JSON.parse(toolResult as string) : toolResult;
		} catch {
			return toolResult;
		}
	});

	let resultTitle = $derived.by(() => {
		if (!shouldRenderResult || !resultConfig || resultConfig.mode !== 'collapsible') return '';
		return typeof resultConfig.title === 'function'
			? resultConfig.title(parsedResultData)
			: resultConfig.title || m.chat_tool_renderer_details();
	});

	let resultDefaultOpen = $derived.by(() => {
		if (!shouldRenderResult || !resultConfig || resultConfig.mode !== 'collapsible') return false;
		if (autoExpandTools) return true;
		return resultConfig.defaultOpen ?? false;
	});

	let resultContentProps = $derived.by(() => {
		if (!shouldRenderResult || !resultConfig || resultConfig.mode !== 'collapsible') return {};
		return resultConfig.getContentProps?.(parsedResultData) || {};
	});

	let resultSuccessMessage = $derived.by(() => {
		if (!shouldRenderResult || !resultConfig) return '';
		if (resultConfig.contentKind !== 'successMessage') return '';
		return resultConfig.getMessage?.(parsedResultData) || m.chat_tool_renderer_success();
	});
</script>

{#if displayConfig}
	{#if displayConfig.mode === 'inline'}
		{@const cfg = displayConfig as ToolInputDisplayRule}
		<ChatToolInlineEvent
			{toolName}
			toolResult={toolResult}
			{toolId}
			label={cfg.label}
			value={inlineValue}
			secondary={inlineSecondary}
			action={cfg.action}
			onAction={handleAction}
			style={cfg.style}
			wrapText={cfg.wrapText}
			colorScheme={cfg.colorScheme}
			resultId={mode === 'input' ? `tool-result-${toolId}` : undefined}
		/>
	{:else if displayConfig.mode === 'collapsible'}
		{#if shouldRenderCollapsedAsInline}
			<ChatToolInlineEvent
				{toolName}
				toolResult={toolResult}
				{toolId}
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
				onTitleClick={handleTitleClick}
			>
					{#snippet children()}
						{#if displayConfig.contentKind === 'diff'}
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
								{projectPath}
								{onFileOpen}
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
						/>
						{:else if displayConfig.contentKind === 'successMessage'}
							<div
								class="flex items-center gap-1.5 text-xs text-status-success-foreground"
							>
							<svg
								class="w-3 h-3"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
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
{/if}

{#if shouldRenderResult && resultConfig}
	<div id="tool-result-{toolId}">
		<ChatToolExpandableEvent
			{toolName}
			{toolId}
			title={resultTitle}
			defaultOpen={resultDefaultOpen}
		>
			{#snippet children()}
				{#if resultConfig.contentKind === 'markdown'}
					<ChatToolRichTextView
						content={(resultContentProps.content as string) || ''}
						{projectPath}
						{onFileOpen}
					/>
				{:else if resultConfig.contentKind === 'fileList'}
					<ChatToolFileListView
						files={(resultContentProps.files as string[]) || []}
						onFileClick={onFileOpen}
						title={resultContentProps.title as string | undefined}
					/>
				{:else if resultConfig.contentKind === 'text'}
					<ChatToolPlainTextView
						content={(resultContentProps.content as string) || ''}
						format={(resultContentProps.format as 'plain' | 'json' | 'code') || 'plain'}
					/>
				{:else if resultConfig.contentKind === 'successMessage'}
					<div class="flex items-center gap-1.5 text-xs text-status-success-foreground">
						<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
						</svg>
						{resultSuccessMessage}
					</div>
				{:else if resultConfig.contentKind === 'todoList'}
					<ChatToolTodoListView todos={resultContentProps.todos as TodoItem[] | undefined} />
				{:else if resultConfig.contentKind === 'task'}
					<ChatToolPlainTextView
						content={(resultContentProps.content as string) || ''}
						format="plain"
					/>
				{/if}
			{/snippet}
		</ChatToolExpandableEvent>
	</div>
{/if}
