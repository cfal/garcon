import {
	dropTargetForElements,
	monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import type { DropTargetRecord, Input } from '@atlaskit/pragmatic-drag-and-drop/types';
import { isSidebarChatDragData } from './sidebar-pragmatic-dnd';

type DropHandler = (source: unknown, dropTargets: DropTargetRecord[], input: Input) => void;

export function bindSidebarDesktopReorder(
	viewport: HTMLElement,
	options: {
		instanceId: symbol;
		canReorder(): boolean;
		preview: DropHandler;
		finish: DropHandler;
	},
): () => void {
	const stopDropTarget = dropTargetForElements({
		element: viewport,
		canDrop: ({ source }) =>
			options.canReorder() &&
			isSidebarChatDragData(source.data) &&
			source.data.instanceId === options.instanceId,
	});
	const stopMonitor = monitorForElements({
		canMonitor: ({ source }) =>
			isSidebarChatDragData(source.data) && source.data.instanceId === options.instanceId,
		onDrag: ({ source, location }) =>
			options.preview(source.data, location.current.dropTargets, location.current.input),
		onDropTargetChange: ({ source, location }) =>
			options.preview(source.data, location.current.dropTargets, location.current.input),
		onDrop: ({ source, location }) =>
			options.finish(source.data, location.current.dropTargets, location.current.input),
	});
	return () => {
		stopMonitor();
		stopDropTarget();
	};
}

export function bindSidebarAutoScroll(
	viewport: HTMLElement,
	instanceId: symbol,
	canReorder: () => boolean,
): () => void {
	let disposed = false;
	let cleanupAutoScroll: (() => void) | undefined;
	void import('@atlaskit/pragmatic-drag-and-drop-auto-scroll/element').then(
		({ autoScrollForElements }) => {
			if (disposed) return;
			cleanupAutoScroll = autoScrollForElements({
				element: viewport,
				canScroll: ({ source }) =>
					canReorder() &&
					isSidebarChatDragData(source.data) &&
					source.data.instanceId === instanceId,
				getAllowedAxis: () => 'vertical',
			});
		},
	);
	return () => {
		disposed = true;
		cleanupAutoScroll?.();
	};
}
