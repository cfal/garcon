import type { AppTab } from '$lib/types/app';
import type { SplitLayoutStore } from '$lib/stores/split-layout.svelte';
import * as m from '$lib/paraglide/messages.js';

export type SplitDropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

export type ActiveSplitDropTarget = {
	paneId: string;
	zone: SplitDropZone;
	rect: DOMRect;
	blockedReason?: 'max-panes';
	focusReason?: 'already-open';
};

export type FocusedOverlayRect = {
	top: number;
	left: number;
	width: number;
	height: number;
};

export interface SplitDropZonePresentation {
	zone: SplitDropZone;
	insetClass: string;
	label: () => string;
}

export const SPLIT_DROP_ZONES: SplitDropZonePresentation[] = [
	{ zone: 'top', insetClass: 'inset-x-3 top-3 bottom-[52%]', label: m.workspace_drop_zone_top },
	{
		zone: 'bottom',
		insetClass: 'inset-x-3 top-[52%] bottom-3',
		label: m.workspace_drop_zone_bottom,
	},
	{ zone: 'left', insetClass: 'inset-y-3 left-3 right-[52%]', label: m.workspace_drop_zone_left },
	{
		zone: 'right',
		insetClass: 'inset-y-3 left-[52%] right-3',
		label: m.workspace_drop_zone_right,
	},
	{ zone: 'center', insetClass: 'inset-3', label: m.workspace_drop_zone_replace },
];

interface SplitDropControllerOptions {
	get activeTab(): AppTab;
	get selectedChatId(): string | null;
	get splitLayout(): SplitLayoutStore;
	get splitRootEl(): HTMLDivElement | undefined;
}

export function resolveDropZone(
	rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
	clientX: number,
	clientY: number,
): SplitDropZone {
	const x = clientX - rect.left;
	const y = clientY - rect.top;
	const edgeX = rect.width * 0.25;
	const edgeY = rect.height * 0.25;

	if (y < edgeY) return 'top';
	if (y > rect.height - edgeY) return 'bottom';
	if (x < edgeX) return 'left';
	if (x > rect.width - edgeX) return 'right';
	return 'center';
}

function isSplitEdgeZone(zone: SplitDropZone): boolean {
	return zone !== 'center';
}

// True when a dragleave event actually exits the container instead of
// moving between its children -- child transitions fire dragleave too
// and clearing state on them makes drop overlays flicker.
export function dragLeftContainer(event: DragEvent): boolean {
	const related = event.relatedTarget as HTMLElement | null;
	return !related || !(event.currentTarget as HTMLElement).contains(related);
}

export class SplitDropController {
	#options: SplitDropControllerOptions;

	workspaceDragOver = $state(false);
	activeSplitDropTarget = $state<ActiveSplitDropTarget | null>(null);
	focusedOverlayRect = $state<FocusedOverlayRect | null>(null);

	#showActiveSplitDropLayer = $derived.by(
		() =>
			this.#options.splitLayout.isEnabled &&
			this.#options.activeTab === 'chat' &&
			this.#options.splitLayout.draggedChatId !== null,
	);

	constructor(options: SplitDropControllerOptions) {
		this.#options = options;

		$effect(() => {
			const splitLayout = this.#options.splitLayout;
			const focusedId = splitLayout.focusedPaneId;
			const isEnabled = splitLayout.isEnabled;
			// Depends on tree identity so pane mount/unmount updates the measured target.
			const _rootIdentity = splitLayout.root;
			const root = this.#options.splitRootEl;

			if (!isEnabled || !focusedId || !root) {
				this.focusedOverlayRect = null;
				return;
			}

			let paneEl: HTMLElement | null = null;
			const update = () => {
				paneEl = root.querySelector<HTMLElement>(`[data-pane-id="${focusedId}"] [data-pane-body]`);
				if (!paneEl) {
					this.focusedOverlayRect = null;
					return;
				}
				const rootRect = root.getBoundingClientRect();
				const rect = paneEl.getBoundingClientRect();
				this.focusedOverlayRect = {
					top: rect.top - rootRect.top,
					left: rect.left - rootRect.left,
					width: rect.width,
					height: rect.height,
				};
			};

			update();
			const rafId = requestAnimationFrame(update);

			const resizeObserver = new ResizeObserver(update);
			resizeObserver.observe(root);
			if (paneEl) resizeObserver.observe(paneEl);

			const handleWindowResize = () => update();
			window.addEventListener('resize', handleWindowResize);
			return () => {
				cancelAnimationFrame(rafId);
				resizeObserver.disconnect();
				window.removeEventListener('resize', handleWindowResize);
			};
		});
	}

	get showActiveSplitDropLayer(): boolean {
		return this.#showActiveSplitDropLayer;
	}

	handleWorkspaceDragOver(event: DragEvent): void {
		if (this.#options.splitLayout.isEnabled) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		this.workspaceDragOver = true;
	}

	handleWorkspaceDragLeave(event: DragEvent): void {
		if (!dragLeftContainer(event)) return;
		this.workspaceDragOver = false;
	}

	handleWorkspaceDrop(event: DragEvent): void {
		event.preventDefault();
		this.workspaceDragOver = false;
		const splitLayout = this.#options.splitLayout;
		const draggedChat = splitLayout.draggedChatId;
		const selectedChatId = this.#options.selectedChatId;
		if (!draggedChat || !selectedChatId) return;
		if (draggedChat === selectedChatId) return;

		splitLayout.enableWithChat(selectedChatId);
		const initialPane = splitLayout.panes[0];
		if (initialPane) {
			splitLayout.splitPane(initialPane.id, 'horizontal', draggedChat);
			// Keeps focus on the original chat pane instead of the dropped chat.
			splitLayout.focusPane(initialPane.id);
		}
		splitLayout.endDrag();
	}

	handleActiveSplitDragOver(event: DragEvent): void {
		if (!this.#showActiveSplitDropLayer) return;
		const target = this.resolveActiveSplitDropTarget(event);
		if (!target) return;

		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) event.dataTransfer.dropEffect = target.blockedReason ? 'none' : 'move';
		this.activeSplitDropTarget = target;
	}

	handleActiveSplitDrop(
		event: DragEvent,
		onDropChat: (paneId: string, zone: SplitDropZone) => void,
	): void {
		if (!this.#showActiveSplitDropLayer) return;
		event.preventDefault();
		event.stopPropagation();

		const target = this.activeSplitDropTarget ?? this.resolveActiveSplitDropTarget(event);
		this.activeSplitDropTarget = null;
		if (!target || target.blockedReason) {
			this.#options.splitLayout.endDrag();
			return;
		}

		onDropChat(target.paneId, target.zone);
	}

	handleActiveSplitDragLeave(event: DragEvent): void {
		if (dragLeftContainer(event)) {
			this.activeSplitDropTarget = null;
		}
	}

	resolveActiveSplitDropTarget(event: DragEvent): ActiveSplitDropTarget | null {
		const splitRootEl = this.#options.splitRootEl;
		if (!splitRootEl) return null;

		let fallback: { paneId: string; rect: DOMRect; distance: number } | null = null;
		for (const pane of this.#options.splitLayout.panes) {
			const paneEl = splitRootEl.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"]`);
			if (!paneEl) continue;

			const rect = paneEl.getBoundingClientRect();
			const containsPointer =
				event.clientX >= rect.left &&
				event.clientX <= rect.right &&
				event.clientY >= rect.top &&
				event.clientY <= rect.bottom;
			if (containsPointer) {
				return this.toActiveSplitDropTarget(
					pane.id,
					resolveDropZone(rect, event.clientX, event.clientY),
					rect,
				);
			}

			const centerX = rect.left + rect.width / 2;
			const centerY = rect.top + rect.height / 2;
			const distance = Math.hypot(event.clientX - centerX, event.clientY - centerY);
			if (!fallback || distance < fallback.distance) {
				fallback = { paneId: pane.id, rect, distance };
			}
		}

		if (!fallback) return null;
		return this.toActiveSplitDropTarget(
			fallback.paneId,
			resolveDropZone(fallback.rect, event.clientX, event.clientY),
			fallback.rect,
		);
	}

	previewClass(zone: SplitDropZone): string {
		if (!this.activeSplitDropTarget || this.activeSplitDropTarget.zone !== zone) return 'opacity-0';
		return 'opacity-100';
	}

	previewTone(zone: SplitDropZone): string {
		if (
			this.activeSplitDropTarget?.zone === zone &&
			(this.activeSplitDropTarget.blockedReason === 'max-panes' ||
				this.activeSplitDropTarget.focusReason === 'already-open')
		) {
			return this.activeSplitDropTarget.blockedReason === 'max-panes'
				? 'bg-destructive/10 border-destructive/40'
				: 'bg-accent/15 border-accent/40';
		}
		return zone === 'center' ? 'bg-accent/15 border-accent/40' : 'bg-primary/12 border-primary/30';
	}

	previewLabel(zone: SplitDropZone, fallback: string): string {
		if (
			this.activeSplitDropTarget?.zone === zone &&
			this.activeSplitDropTarget.blockedReason === 'max-panes'
		) {
			return m.workspace_drop_zone_max_panes();
		}
		if (
			this.activeSplitDropTarget?.zone === zone &&
			this.activeSplitDropTarget.focusReason === 'already-open'
		) {
			return m.workspace_drop_zone_already_open();
		}
		return fallback;
	}

	previewLabelClass(zone: SplitDropZone): string {
		if (
			this.activeSplitDropTarget?.zone === zone &&
			this.activeSplitDropTarget.blockedReason === 'max-panes'
		) {
			return 'bg-destructive/10 text-destructive';
		}
		if (
			this.activeSplitDropTarget?.zone === zone &&
			this.activeSplitDropTarget.focusReason === 'already-open'
		) {
			return 'bg-accent/15 text-accent-foreground';
		}
		return zone === 'center' ? 'bg-accent/15 text-accent-foreground' : 'bg-primary/10 text-primary';
	}

	activeTargetStyle(): string {
		const splitRootEl = this.#options.splitRootEl;
		if (!splitRootEl || !this.activeSplitDropTarget) return '';

		const rootRect = splitRootEl.getBoundingClientRect();
		const rect = this.activeSplitDropTarget.rect;
		return [
			`top:${rect.top - rootRect.top}px`,
			`left:${rect.left - rootRect.left}px`,
			`width:${rect.width}px`,
			`height:${rect.height}px`,
		].join(';');
	}

	#isExistingSidebarChat(draggedChat: string | null): boolean {
		const splitLayout = this.#options.splitLayout;
		return (
			!!draggedChat &&
			!splitLayout.draggedPaneId &&
			splitLayout.panes.some((pane) => pane.chatId === draggedChat)
		);
	}

	#toBlockedReason(isExistingSidebarChat: boolean, zone: SplitDropZone): 'max-panes' | undefined {
		if (isExistingSidebarChat) return undefined;
		const paneCount = this.#options.splitLayout.paneCount;
		if (typeof paneCount !== 'number' || paneCount < 4) return undefined;
		return isSplitEdgeZone(zone) ? 'max-panes' : undefined;
	}

	private toActiveSplitDropTarget(
		paneId: string,
		zone: SplitDropZone,
		rect: DOMRect,
	): ActiveSplitDropTarget {
		const draggedChat = this.#options.splitLayout.draggedChatId;
		const isExistingSidebarChat = this.#isExistingSidebarChat(draggedChat);
		return {
			paneId,
			zone,
			rect,
			focusReason: isExistingSidebarChat ? 'already-open' : undefined,
			blockedReason: this.#toBlockedReason(isExistingSidebarChat, zone),
		};
	}
}
