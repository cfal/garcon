import type { TicketStatus, TicketSummary } from '$shared/tickets';

type DragModule = typeof import('@atlaskit/pragmatic-drag-and-drop/element/adapter');
let modulePromise: Promise<DragModule> | null = null;
const load = () => (modulePromise ??= import('@atlaskit/pragmatic-drag-and-drop/element/adapter'));

export function ticketDraggable(
	node: HTMLElement,
	options: { getTicket: () => TicketSummary; canDrag: () => boolean },
) {
	let disposed = false;
	let cleanup = () => {};
	const dragHandle = node.querySelector<HTMLElement>('[data-ticket-drag]');
	if (dragHandle && window.matchMedia?.('(pointer: fine)').matches)
		void load()
			.then(({ draggable }) => {
				if (disposed) return;
				cleanup = draggable({
					element: node,
					dragHandle,
					canDrag: () => options.canDrag(),
					getInitialData: () => ({ type: 'garcon-ticket', ticket: options.getTicket() }),
				});
			})
			.catch(() => {});
	return {
		update(next: typeof options) {
			options = next;
		},
		destroy() {
			disposed = true;
			cleanup();
		},
	};
}

export function ticketDropTarget(
	node: HTMLElement,
	options: { status: TicketStatus; onDrop: (ticket: TicketSummary, status: TicketStatus) => void },
) {
	let disposed = false;
	let cleanup = () => {};
	if (window.matchMedia?.('(pointer: fine)').matches)
		void load()
			.then(({ dropTargetForElements }) => {
				if (disposed) return;
				cleanup = dropTargetForElements({
					element: node,
					canDrop: ({ source }) =>
						source.data.type === 'garcon-ticket' &&
						((source.data.ticket as TicketSummary).status !== 'closed' || options.status === 'open'),
					onDragEnter: () => node.setAttribute('data-ticket-drop', ''),
					onDragLeave: () => node.removeAttribute('data-ticket-drop'),
					onDrop: ({ source }) => {
						node.removeAttribute('data-ticket-drop');
						if (source.data.type === 'garcon-ticket')
							options.onDrop(source.data.ticket as TicketSummary, options.status);
					},
				});
			})
			.catch(() => {});
	return {
		update(next: typeof options) {
			options = next;
		},
		destroy() {
			disposed = true;
			cleanup();
		},
	};
}
