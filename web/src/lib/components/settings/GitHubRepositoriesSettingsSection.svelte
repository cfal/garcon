<script lang="ts">
	import {
		getAppShell,
		getNotifications,
		getPullRequestReviews,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import PullRequestRepositoriesPanel from '$lib/components/pr/PullRequestRepositoriesPanel.svelte';
	import { errorMessage } from '$lib/utils/error-message.js';
	import * as m from '$lib/paraglide/messages.js';

	const reviews = getPullRequestReviews();
	const appShell = getAppShell();
	const workspace = getWorkspaceCoordinator();
	const notifications = getNotifications();

	async function openChat(chatId: string): Promise<void> {
		try {
			await workspace.showChatInCurrentWindow(chatId);
			appShell.closeSettings();
		} catch (error) {
			notifications.error(errorMessage(error, m.pull_request_review_action_failed()));
		}
	}
</script>

<section class="min-w-0 space-y-4" aria-labelledby="github-repositories-title">
	<div class="space-y-1">
		<h3 id="github-repositories-title" class="text-sm font-medium text-foreground">
			{m.pull_request_repositories()}
		</h3>
		<p class="text-sm text-muted-foreground">{m.pull_request_repositories_description()}</p>
	</div>
	<PullRequestRepositoriesPanel {reviews} onOpenChat={openChat} />
</section>
