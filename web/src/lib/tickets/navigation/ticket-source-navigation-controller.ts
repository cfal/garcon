import { resolveTicketSource } from '$lib/api/ticket-source.js';
import { ApiError } from '$lib/api/client.js';
import type { TranscriptNavigationController } from '$lib/chat/actions/transcript-navigation-controller.js';
import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';
import type { TicketBootstrap, TicketSource } from '$shared/tickets';
import * as m from '$lib/paraglide/messages.js';

type Partition = Pick<TicketBootstrap, 'storeId' | 'viewerKey'>;

export interface TicketSourceNavigationDeps {
	navigation: Pick<TranscriptNavigationController, 'open'>;
	notifications: { info(message: string): void; error(message: string): void };
	resolve?: typeof resolveTicketSource;
}

export class TicketSourceNavigationController {
	constructor(private readonly deps: TicketSourceNavigationDeps) {}

	async open(
		source: TicketSource,
		host: WorkspaceWindowId | 'mobile',
		getPartition: () => Partition | null,
	): Promise<void> {
		const partition = getPartition();
		await this.deps.navigation.open({
			chatId: source.chatId,
			host,
			ownsSource: () =>
				!!partition &&
				getPartition()?.storeId === partition.storeId &&
				getPartition()?.viewerKey === partition.viewerKey,
			resolve: async (signal) => {
				const resolution = await (this.deps.resolve ?? resolveTicketSource)(source, signal);
				if (resolution.kind === 'found') return resolution;
				if (resolution.kind === 'transcript-reloaded') return { kind: 'view-changed' };
				return { kind: 'unavailable' };
			},
			onResult: (result) => {
				if (result === 'view-changed') this.deps.notifications.info(m.tickets_source_reloaded());
				else if (result === 'unavailable') this.deps.notifications.info(m.tickets_source_missing());
			},
			onError: (error) => {
				const message =
					error instanceof ApiError && error.errorCode === 'SESSION_NOT_FOUND'
						? m.tickets_source_chat_missing()
						: m.tickets_source_failed();
				this.deps.notifications.error(message);
			},
		});
	}
}
