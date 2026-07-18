<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import { SNIPPET_ARGUMENTS_MAX_LENGTH, type Snippet } from '$shared/snippets';

	interface Props {
		open: boolean;
		snippet: Snippet | null;
		initialArguments?: string;
		onClose: () => void;
		onSubmit: (snippet: Snippet, argumentsText: string) => void;
		onRequestComposerFocus: () => void;
	}

	let {
		open,
		snippet,
		initialArguments = '',
		onClose,
		onSubmit,
		onRequestComposerFocus,
	}: Props = $props();
	let argumentsText = $state('');
	let restoreComposerFocus = true;
	const argumentsTooLong = $derived(argumentsText.length > SNIPPET_ARGUMENTS_MAX_LENGTH);

	$effect(() => {
		if (!open) return;
		argumentsText = initialArguments;
		restoreComposerFocus = true;
	});

	function submit(): void {
		if (!snippet || argumentsTooLong) return;
		const selectedSnippet = snippet;
		const selectedArguments = argumentsText;
		restoreComposerFocus = false;
		onClose();
		queueMicrotask(() => onSubmit(selectedSnippet, selectedArguments));
	}

	function handleSubmit(event: SubmitEvent): void {
		event.preventDefault();
		submit();
	}

	function handleKeyDown(event: KeyboardEvent): void {
		if (event.key === 'Escape' && event.isComposing) {
			event.stopPropagation();
			return;
		}
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
		event.preventDefault();
		submit();
	}

	function handleCloseAutoFocus(event: Event): void {
		event.preventDefault();
		if (restoreComposerFocus) queueMicrotask(onRequestComposerFocus);
		restoreComposerFocus = true;
	}
</script>

<Dialog.Root {open} requestClose={onClose}>
	<Dialog.Content
		class="top-[var(--app-viewport-center-y)] max-h-[calc(var(--app-height)-1rem)] w-[calc(100vw-1rem)] overflow-y-auto sm:top-[50%] sm:w-full sm:max-w-lg"
		onCloseAutoFocus={handleCloseAutoFocus}
	>
		<Dialog.Header>
			<Dialog.Title>
				{m.snippets_arguments_title({ shortName: snippet?.shortName ?? '' })}
			</Dialog.Title>
			<Dialog.Description>
				{m.snippets_arguments_description({ argumentsToken: '{{arguments}}' })}
			</Dialog.Description>
		</Dialog.Header>

		<form class="space-y-5" onsubmit={handleSubmit}>
			<div class="space-y-1.5">
				<label for="snippet-arguments" class="text-sm font-medium text-foreground">
					{m.snippets_arguments_label()}
				</label>
				<textarea
					id="snippet-arguments"
					bind:value={argumentsText}
					onkeydown={handleKeyDown}
					rows="5"
					placeholder={m.snippets_arguments_placeholder()}
					aria-invalid={argumentsTooLong}
					aria-describedby="snippet-arguments-error"
					class="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-base leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
				></textarea>
				<p id="snippet-arguments-error" class="min-h-4 text-xs text-destructive">
					{argumentsTooLong ? m.snippets_arguments_too_long() : ''}
				</p>
			</div>

			<Dialog.Footer>
				<Button variant="secondary" onclick={onClose}>{m.snippets_cancel()}</Button>
				<Button type="submit" disabled={argumentsTooLong}>
					{m.snippets_arguments_insert()}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
