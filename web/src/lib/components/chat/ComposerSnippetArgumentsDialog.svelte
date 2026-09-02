<script lang="ts">
	import { flushSync, tick } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import {
		SNIPPET_ARGUMENTS_MAX_LENGTH,
		SNIPPET_ARGUMENTS_TOKEN,
		type Snippet,
	} from '$shared/snippets';

	interface Props {
		open: boolean;
		snippet: Snippet | null;
		initialArguments?: string;
		onClose: () => void;
		onSubmit: (snippet: Snippet, argumentsText: string) => void;
		onCancelled: () => void;
		onReturnFocus: () => void;
	}

	let {
		open,
		snippet,
		initialArguments = '',
		onClose,
		onSubmit,
		onCancelled,
		onReturnFocus,
	}: Props = $props();
	let argumentsText = $state('');
	let argumentsRef: HTMLTextAreaElement | null = null;
	let cancelOnClose = true;
	let wasOpen = false;
	const uid = $props.id();
	const argumentsId = `${uid}-arguments`;
	const argumentsErrorId = `${uid}-arguments-error`;
	const argumentsTooLong = $derived(argumentsText.length > SNIPPET_ARGUMENTS_MAX_LENGTH);

	$effect(() => {
		const nextOpen = open;
		if (nextOpen && !wasOpen) {
			argumentsText = initialArguments;
			cancelOnClose = true;
		}
		wasOpen = nextOpen;
	});

	function closeDialog(): void {
		flushSync(onClose);
	}

	function submit(): void {
		if (!snippet || argumentsTooLong) return;
		const selectedSnippet = snippet;
		const selectedArguments = argumentsText;
		cancelOnClose = false;
		closeDialog();
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

	function handleOpenAutoFocus(event: Event): void {
		event.preventDefault();
		if (focusArguments()) return;
		queueMicrotask(focusArguments);
	}

	function focusArguments(): boolean {
		if (!open || !argumentsRef) return false;
		argumentsRef.focus({ preventScroll: true });
		const end = argumentsRef.value.length;
		// Selects a pre-filled default so typing replaces it; an edited retry draft keeps the caret at the end.
		const isDefaultPrefill =
			snippet !== null && end > 0 && argumentsRef.value === snippet.defaultArguments;
		argumentsRef.setSelectionRange(isDefaultPrefill ? 0 : end, end);
		return true;
	}

	function clearArguments(): void {
		argumentsText = '';
		void tick().then(() => {
			argumentsRef?.focus({ preventScroll: true });
			argumentsRef?.setSelectionRange(0, 0);
		});
	}

	function handleCloseAutoFocus(event: Event): void {
		event.preventDefault();
		if (cancelOnClose) onCancelled();
		cancelOnClose = true;
		onReturnFocus();
	}
</script>

<Dialog.Root {open} requestClose={closeDialog}>
	<Dialog.Content
		class="top-[var(--app-viewport-center-y)] flex h-[min(30rem,calc(var(--app-height)-1rem))] w-[calc(100vw-1rem)] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:pointer-fine:top-[50%] sm:pointer-fine:h-auto sm:pointer-fine:max-h-[min(36rem,calc(var(--app-height)-2rem))]"
		onOpenAutoFocus={handleOpenAutoFocus}
		onCloseAutoFocus={handleCloseAutoFocus}
	>
		<Dialog.Header class="shrink-0 border-b border-border px-5 py-4 pr-12 sm:pl-6 sm:pr-12">
			<Dialog.Title>
				{m.snippets_arguments_title({ shortName: snippet?.shortName ?? '' })}
			</Dialog.Title>
			<Dialog.Description>
				{m.snippets_arguments_description({ argumentsToken: SNIPPET_ARGUMENTS_TOKEN })}
			</Dialog.Description>
		</Dialog.Header>

		<form class="flex min-h-0 flex-1 flex-col" onsubmit={handleSubmit}>
			<div class="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
				<label for={argumentsId} class="text-sm font-medium text-foreground">
					{m.snippets_arguments_label()}
				</label>
				<textarea
					bind:this={argumentsRef}
					id={argumentsId}
					bind:value={argumentsText}
					onkeydown={handleKeyDown}
					rows="5"
					placeholder={m.snippets_arguments_placeholder()}
					aria-invalid={argumentsTooLong}
					aria-describedby={argumentsErrorId}
					class="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-base leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
				></textarea>
				<div class="flex min-h-8 justify-end">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={argumentsText.length === 0}
						onclick={clearArguments}
					>
						{m.snippets_arguments_clear()}
					</Button>
				</div>
				<p id={argumentsErrorId} class="min-h-4 text-xs text-destructive">
					{argumentsTooLong ? m.snippets_arguments_too_long() : ''}
				</p>
			</div>

			<Dialog.Footer class="shrink-0 border-t border-border px-5 py-3 sm:px-6">
				<Button variant="secondary" onclick={closeDialog}>{m.snippets_cancel()}</Button>
				<Button type="submit" disabled={argumentsTooLong}>
					{m.snippets_arguments_insert()}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
