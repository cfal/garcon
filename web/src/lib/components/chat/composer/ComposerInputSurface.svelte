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
		onRecallReset,
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
		onRecallReset: () => void;
	} = $props();
	const contentSizing = contentSizedTextarea(() => (visible ? text : undefined));
</script>

<div class="relative overflow-hidden bg-transparent focus-within:ring-0">
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
					snippetTrigger={controller.snippetTrigger}
					{onComposerKeydown}
					{onCompletionKeydown}
					onChange={(text) => controller.change(text)}
					onSourceAction={(text, caret) => controller.plain(text, caret)}
					onSnippet={(text, caret) => controller.snippet(text, caret)}
					onReady={(target) => controller.focus(target)}
					onMention={(mention) => controller.mention(mention)}
					onLargePaste={(request) => void controller.pasteSource(request)}
					onMarkdownPaste={(source, caret, apply) => void controller.pasteMarkdown(source, caret, apply)}
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
			placeholder={m.chat_composer_reply_placeholder()}
			{disabled}
			readonly={sourceReadOnly}
			aria-busy={busy}
			class="content-sized-textarea block w-full bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring text-composer-foreground placeholder:text-muted-foreground disabled:opacity-50 max-h-[min(40dvh,150px)] sm:max-h-[min(40dvh,300px)] text-base leading-6 transition-colors duration-200 px-4 py-3 sm:px-5 sm:py-3.5 min-h-[48px]"
		></textarea>
	</div>
</div>
