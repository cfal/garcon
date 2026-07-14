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
	// Faint target-map region, matching the pointer bands in resolveDropZone
	// so every zone shows exactly where its hit area is.
	hitInsetClass: string;
	// Strong outcome preview showing the half (or whole) the drop will fill.
	resultInsetClass: string;
	label: () => string;
}

export const SPLIT_DROP_ZONES: SplitDropZonePresentation[] = [
	{
		zone: 'top',
		hitInsetClass: 'top-1.5 inset-x-1.5 bottom-[75%]',
		resultInsetClass: 'top-1.5 inset-x-1.5 bottom-[50%]',
		label: m.workspace_drop_zone_top,
	},
	{
		zone: 'bottom',
		hitInsetClass: 'bottom-1.5 inset-x-1.5 top-[75%]',
		resultInsetClass: 'bottom-1.5 inset-x-1.5 top-[50%]',
		label: m.workspace_drop_zone_bottom,
	},
	{
		zone: 'left',
		hitInsetClass: 'left-1.5 top-[25%] bottom-[25%] right-[75%]',
		resultInsetClass: 'left-1.5 inset-y-1.5 right-[50%]',
		label: m.workspace_drop_zone_left,
	},
	{
		zone: 'right',
		hitInsetClass: 'right-1.5 top-[25%] bottom-[25%] left-[75%]',
		resultInsetClass: 'right-1.5 inset-y-1.5 left-[50%]',
		label: m.workspace_drop_zone_right,
	},
	{
		zone: 'center',
		hitInsetClass: 'inset-[25%]',
		resultInsetClass: 'inset-1.5',
		label: m.workspace_drop_zone_replace,
	},
];

interface SplitDropControllerOptions {
	get isChatDropEligible(): boolean;
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
	ignoreNativeDragUntilEnd = $state(false);

	#showActiveSplitDropLayer = $derived.by(
		() =>
			this.#options.splitLayout.isEnabled &&
			this.#options.isChatDropEligible &&
			!this.ignoreNativeDragUntilEnd &&
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
		if (!this.#canHandleDrag() || this.#options.splitLayout.isEnabled) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		this.workspaceDragOver = true;
	}

	handleWorkspaceDragLeave(event: DragEvent): void {
		if (this.ignoreNativeDragUntilEnd) return;
		if (!dragLeftContainer(event)) return;
		this.workspaceDragOver = false;
	}

	handleWorkspaceDrop(event: DragEvent): void {
		if (!this.#canHandleDrag()) return;
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
		if (!this.#canHandleDrag() || !this.#showActiveSplitDropLayer) return;
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
		if (!this.#canHandleDrag() || !this.#showActiveSplitDropLayer) return;
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
		if (this.ignoreNativeDragUntilEnd) return;
		if (dragLeftContainer(event)) {
			this.activeSplitDropTarget = null;
		}
	}

	resolveActiveSplitDropTarget(event: DragEvent): ActiveSplitDropTarget | null {
		if (!this.#canHandleDrag()) return null;
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

	isActiveZone(zone: SplitDropZone): boolean {
		return this.activeSplitDropTarget?.zone === zone;
	}

	// Faint outline for every droppable region, drawn the moment a drag
	// enters a pane so the whole target map is visible at once instead of
	// only the strip under the pointer. The hovered region reads brighter.
	zoneMapClass(zone: SplitDropZone): string {
		return this.isActiveZone(zone)
			? 'border border-primary/40 bg-primary/10'
			: 'border border-dashed border-primary/20 bg-primary/[0.04]';
	}

	// Inset of the strong outcome preview for whichever zone is hovered.
	get activeResultInset(): string | null {
		const target = this.activeSplitDropTarget;
		if (!target) return null;
		return SPLIT_DROP_ZONES.find((entry) => entry.zone === target.zone)?.resultInsetClass ?? null;
	}

	resultToneClass(): string {
		const target = this.activeSplitDropTarget;
		if (!target) return '';
		if (target.blockedReason === 'max-panes') return 'bg-destructive/15 border-2 border-destructive/50';
		if (target.focusReason === 'already-open') return 'bg-accent/20 border-2 border-accent/50';
		return target.zone === 'center'
			? 'bg-accent/20 border-2 border-accent/50'
			: 'bg-primary/20 border-2 border-primary/50';
	}

	resultLabel(): string {
		const target = this.activeSplitDropTarget;
		if (!target) return '';
		if (target.blockedReason === 'max-panes') return m.workspace_drop_zone_max_panes();
		if (target.focusReason === 'already-open') return m.workspace_drop_zone_already_open();
		return SPLIT_DROP_ZONES.find((entry) => entry.zone === target.zone)?.label() ?? '';
	}

	resultLabelClass(): string {
		const target = this.activeSplitDropTarget;
		if (target?.blockedReason === 'max-panes') return 'bg-destructive/15 text-destructive';
		if (target?.focusReason === 'already-open') return 'bg-accent/20 text-accent-foreground';
		return target?.zone === 'center'
			? 'bg-accent/20 text-accent-foreground'
			: 'bg-primary/15 text-primary';
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

	cancelApplicationDrag(): void {
		const suppressRemainder = this.hasApplicationDragState();
		this.workspaceDragOver = false;
		this.activeSplitDropTarget = null;
		if (suppressRemainder) this.ignoreNativeDragUntilEnd = true;
		this.#options.splitLayout.endDrag();
		this.cleanupApplicationDragResources();
	}

	releaseNativeDragIgnore(): void {
		this.ignoreNativeDragUntilEnd = false;
	}

	hasApplicationDragState(): boolean {
		return (
			this.#options.splitLayout.draggedChatId !== null ||
			this.workspaceDragOver ||
			this.activeSplitDropTarget !== null ||
			this.ignoreNativeDragUntilEnd
		);
	}

	cleanupApplicationDragResources(): void {
		document.body.style.removeProperty('cursor');
		document.body.style.removeProperty('user-select');
	}

	#canHandleDrag(): boolean {
		return this.#options.isChatDropEligible && !this.ignoreNativeDragUntilEnd;
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
