import type { ApiProvidersStore } from '$lib/api-providers/api-providers-store.svelte.js';
import type { ChatBoardInvalidationHub } from '$lib/chat-board/catalog/chat-board-invalidation-hub.js';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import type { PullRequestReviewsStore } from '$lib/git/pull-requests/pull-request-reviews-store.svelte.js';
import type { ChatPreambleSelectionInvalidationHub } from '$lib/preambles/chat-selection-invalidation-hub.js';
import type { PreamblesStore } from '$lib/preambles/preambles-store.svelte.js';
import type { ScheduledPromptsStore } from '$lib/scheduling/scheduled-prompts-store.svelte.js';
import type { SnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import type { TicketsInvalidationHub } from '$lib/tickets/catalog/tickets-invalidation-hub.js';
import type { WsPushEvents } from '$lib/ws/connection.svelte.js';

interface WorkspaceEventTargets {
	apiProviders: Pick<ApiProvidersStore, 'invalidate'>;
	chatBoardInvalidations: Pick<ChatBoardInvalidationHub, 'publish'>;
	executors: Pick<ExecutorsStore, 'applySnapshot'>;
	preambles: Pick<PreamblesStore, 'refreshIfLoaded'>;
	preambleSelections: Pick<ChatPreambleSelectionInvalidationHub, 'publish'>;
	pullRequestReviews: Pick<PullRequestReviewsStore, 'invalidate'>;
	remoteSettings: Pick<RemoteSettingsStore, 'applySnapshot'>;
	scheduledPrompts: Pick<ScheduledPromptsStore, 'refreshIfLoaded'>;
	snippets: Pick<SnippetsStore, 'refreshIfLoaded'>;
	ticketsInvalidations: Pick<TicketsInvalidationHub, 'publish'>;
}

export function subscribeWorkspaceEvents(
	ws: WsPushEvents,
	targets: WorkspaceEventTargets,
): () => void {
	const unsubscribers = [
		ws.onMessageType('api-providers-invalidated', () => targets.apiProviders.invalidate()),
		ws.onMessageType('chat-boards-invalidated', ({ revision, reason }) =>
			targets.chatBoardInvalidations.publish({ kind: 'catalog', revision, reason }),
		),
		ws.onMessageType('executors-changed', ({ executors }) =>
			targets.executors.applySnapshot(executors),
		),
		ws.onMessageType('preambles-invalidated', () => void targets.preambles.refreshIfLoaded()),
		ws.onMessageType('chat-preambles-invalidated', ({ chatId, revision }) =>
			targets.preambleSelections.publish({ kind: 'selection', chatId, revision }),
		),
		ws.onMessageType('pull-request-reviews-invalidated', ({ revision }) =>
			targets.pullRequestReviews.invalidate(revision),
		),
		ws.onMessageType('settings-changed', ({ settings }) =>
			targets.remoteSettings.applySnapshot(settings),
		),
		ws.onMessageType(
			'scheduled-prompts-invalidated',
			() => void targets.scheduledPrompts.refreshIfLoaded(),
		),
		ws.onMessageType('snippets-invalidated', () => void targets.snippets.refreshIfLoaded()),
		ws.onMessageType('tickets-invalidated', ({ revision }) =>
			targets.ticketsInvalidations.publish({ kind: 'collection', revision }),
		),
	];
	return () => {
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
}
