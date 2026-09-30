import { setTicketDispatch } from '$lib/context/tickets-context.js';
import {
	TicketDispatchController,
	type TicketDispatchControllerDeps,
} from '../ticket-dispatch-controller.svelte.js';

/** Provides a dispatch controller to a test host; call it during component initialization. */
export function setTicketDispatchTestContext(
	deps: Pick<TicketDispatchControllerDeps, 'remoteSettings' | 'modelCatalog'> &
		Partial<TicketDispatchControllerDeps>,
): TicketDispatchController {
	const controller = new TicketDispatchController({
		sessions: { byId: {} },
		notifications: { error: () => undefined },
		startChat: () => undefined,
		validateProject: async () => ({ valid: true }),
		...deps,
	});
	setTicketDispatch(controller);
	return controller;
}
