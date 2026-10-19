<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { contentSizedTextarea } from '$lib/components/ui/textarea/content-sized-textarea.svelte.js';
	import { loadComposerMarkdownEditor } from './composer-markdown-editor-loader.js';
	import type { ComposerMarkdownDocument } from './composer-markdown-parser.js';
	import type { PromptComposerMarkdownController } from './prompt-composer-markdown-controller.js';
	let {
		draft,
		disabled,
		busy,
		sourceReadOnly,
		visible,
		text,
		textarea = $bindable(),
		controller,
		onComposerKeydown,
		onCompletionKeydown,
		onInput,
		onRecallReset = () => {},
		onPaste,
		placeholder = m.chat_composer_reply_placeholder(),
		allowFileMentions = true,
	}: {
		draft: ({ source: string } & ComposerMarkdownDocument) | null;
		disabled: boolean;
		busy: boolean;
		sourceReadOnly: boolean;
		visible: boolean;
		text: string;
		textarea: HTMLTextAreaElement | undefined;
		controller: PromptComposerMarkdownController;
		onComposerKeydown: (event: KeyboardEvent) => void;
		onCompletionKeydown: (event: KeyboardEvent) => boolean;
		onInput: (event: Event) => void;
		onRecallReset?: () => void;
		onPaste?: (event: ClipboardEvent) => void;
		placeholder?: string;
		allowFileMentions?: boolean;
	} = $props();
	const contentSizing = contentSizedTextarea(() => (visible ? text : undefined));
</script>

<div
	class="relative overflow-hidden bg-transparent focus-within:ring-0"
	onpaste={onPaste}
	role="presentation"
>
	{#if draft}
		<!-- The controller publishes a draft only after this cached import succeeds. -->
		{#await loadComposerMarkdownEditor() then MarkdownEditor}
			{#key draft.document}
				<MarkdownEditor
					document={draft.document}
					sources={draft.sources}
					selection={draft.selection}
					selectionMarks={draft.selectionMarks}
					readOnly={disabled || busy}
					{placeholder}
					{allowFileMentions}
					snippetTrigger={controller.snippetTrigger}
					{onComposerKeydown}
					{onCompletionKeydown}
					onChange={(text) => controller.change(text)}
					onSourceAction={(text, caret) => controller.plain(text, caret)}
					onSnippet={(text, caret) => controller.snippet(text, caret)}
					onReady={(target) => controller.focus(target)}
					onMention={(mention) => controller.mention(mention)}
					onLargePaste={(request) => void controller.pasteSource(request)}
					onMarkdownPaste={(source, caret, apply) =>
						void controller.pasteMarkdown(source, caret, apply)}
					onOverflow={(source) => controller.overflow(source)}
				/>
			{/key}
		{/await}
	{/if}
	<div class="relative z-10" hidden={Boolean(draft)}>
		<textarea
			{@attach contentSizing}
			rows="1"
			bind:this={textarea}
			value={text}
			onkeydown={onComposerKeydown}
			onpointerdown={onRecallReset}
			oninput={onInput}
			oncompositionend={() => controller.input(new InputEvent('input'))}
			{placeholder}
			{disabled}
			readonly={sourceReadOnly}
			aria-busy={busy}
			class="content-sized-textarea block w-full bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring text-composer-foreground placeholder:text-muted-foreground disabled:opacity-50 max-h-[var(--composer-input-max-height,min(40dvh,150px))] sm:max-h-[var(--composer-input-max-height,min(40dvh,300px))] text-base leading-6 transition-colors duration-200 px-4 py-3 sm:px-5 sm:py-3.5 min-h-[48px]"
		></textarea>
	</div>
</div>
