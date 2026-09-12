import type { IssueStatus, IssueSummary } from '$shared/issues';

type DragModule = typeof import('@atlaskit/pragmatic-drag-and-drop/element/adapter');
let modulePromise: Promise<DragModule> | null = null;
const load = () => (modulePromise ??= import('@atlaskit/pragmatic-drag-and-drop/element/adapter'));

export function issueDraggable(
	node: HTMLElement,
	options: { getIssue: () => IssueSummary; canDrag: () => boolean },
) {
	let disposed = false;
	let cleanup = () => {};
	const dragHandle = node.querySelector<HTMLElement>('[data-issue-drag]');
	if (dragHandle && window.matchMedia?.('(pointer: fine)').matches)
		void load()
			.then(({ draggable }) => {
				if (disposed) return;
				cleanup = draggable({
					element: node,
					dragHandle,
					canDrag: () => options.canDrag(),
					getInitialData: () => ({ type: 'garcon-issue', issue: options.getIssue() }),
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

export function issueDropTarget(
	node: HTMLElement,
	options: { status: IssueStatus; onDrop: (issue: IssueSummary, status: IssueStatus) => void },
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
						source.data.type === 'garcon-issue' &&
						((source.data.issue as IssueSummary).status !== 'closed' || options.status === 'open'),
					onDragEnter: () => node.setAttribute('data-issue-drop', ''),
					onDragLeave: () => node.removeAttribute('data-issue-drop'),
					onDrop: ({ source }) => {
						node.removeAttribute('data-issue-drop');
						if (source.data.type === 'garcon-issue')
							options.onDrop(source.data.issue as IssueSummary, options.status);
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
