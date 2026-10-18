<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import type { PullRequestReviewsStore } from '$lib/git/pull-requests/pull-request-reviews-store.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import PullRequestRepositoriesPanel from './PullRequestRepositoriesPanel.svelte';

	let {
		reviews,
		onOpenChat,
		onClose,
	}: {
		reviews: PullRequestReviewsStore;
		onOpenChat: (chatId: string) => void;
		onClose: () => void;
	} = $props();
</script>

<Dialog.Root open onOpenChange={(value) => !value && onClose()}>
	<Dialog.Content class="flex max-h-[85dvh] flex-col sm:max-w-4xl" data-pr-repositories-dialog>
		<Dialog.Header>
			<Dialog.Title>{m.pull_request_repositories()}</Dialog.Title>
			<Dialog.Description>{m.pull_request_repositories_description()}</Dialog.Description>
		</Dialog.Header>
		<div class="min-h-0 flex-1 overflow-y-auto">
			<PullRequestRepositoriesPanel {reviews} {onOpenChat} />
		</div>
	</Dialog.Content>
</Dialog.Root>
