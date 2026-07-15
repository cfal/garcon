// Split layout state model. Tracks a binary tree of panes where each
// leaf holds a chatId and each branch defines a split direction with a
// drag-adjustable ratio. Supports 1-4 simultaneous chat panes.

export type SplitDirection = 'horizontal' | 'vertical';

export interface PaneNode {
	type: 'pane';
	id: string;
	chatId: string;
}

export interface SplitNode {
	type: 'split';
	direction: SplitDirection;
	ratio: number;
	children: [LayoutNode, LayoutNode];
}

export type LayoutNode = PaneNode | SplitNode;

let paneCounter = 0;
function nextPaneId(): string {
	return `pane-${++paneCounter}`;
}

// Collects all leaf pane nodes from the tree.
function collectPanes(node: LayoutNode): PaneNode[] {
	if (node.type === 'pane') return [node];
	return [...collectPanes(node.children[0]), ...collectPanes(node.children[1])];
}

// Finds and replaces a pane node by id, returning a new tree.
function replacePaneById(
	node: LayoutNode,
	paneId: string,
	replacement: LayoutNode,
): LayoutNode | null {
	if (node.type === 'pane') {
		return node.id === paneId ? replacement : null;
	}
	const leftResult = replacePaneById(node.children[0], paneId, replacement);
	if (leftResult) {
		return { ...node, children: [leftResult, node.children[1]] };
	}
	const rightResult = replacePaneById(node.children[1], paneId, replacement);
	if (rightResult) {
		return { ...node, children: [node.children[0], rightResult] };
	}
	return null;
}

// Removes a pane by id, collapsing its parent split into the sibling.
function removePaneById(node: LayoutNode, paneId: string): LayoutNode | null {
	if (node.type === 'pane') {
		return node.id === paneId ? null : node;
	}

	const [left, right] = node.children;

	if (left.type === 'pane' && left.id === paneId) return right;
	if (right.type === 'pane' && right.id === paneId) return left;

	const leftResult = removePaneById(left, paneId);
	if (leftResult !== left && leftResult !== null) {
		return { ...node, children: [leftResult, right] };
	}

	const rightResult = removePaneById(right, paneId);
	if (rightResult !== right && rightResult !== null) {
		return { ...node, children: [left, rightResult] };
	}

	return node;
}

export class SplitLayoutStore {
	root = $state<LayoutNode | null>(null);
	focusedPaneId = $state<string | null>(null);
	draggedChatId = $state<string | null>(null);
	// Set when the drag originates from a pane header (for swap operations).
	draggedPaneId = $state<string | null>(null);

	get isEnabled(): boolean {
		return this.root !== null;
	}

	get panes(): PaneNode[] {
		if (!this.root) return [];
		return collectPanes(this.root);
	}

	get paneCount(): number {
		return this.panes.length;
	}

	get focusedChatId(): string | null {
		if (!this.focusedPaneId || !this.root) return null;
		const pane = this.panes.find((p) => p.id === this.focusedPaneId);
		return pane?.chatId ?? null;
	}

	// Enters split mode with a single pane for the given chat.
	enableWithChat(chatId: string): void {
		const pane: PaneNode = { type: 'pane', id: nextPaneId(), chatId };
		this.root = pane;
		this.focusedPaneId = pane.id;
	}

	disable(): void {
		this.root = null;
		this.focusedPaneId = null;
	}

	focusPane(paneId: string): void {
		this.focusedPaneId = paneId;
	}

	// Splits an existing pane, placing the new chat in the specified position.
	splitPane(
		paneId: string,
		direction: SplitDirection,
		newChatId: string,
		position: 'before' | 'after' = 'after',
	): void {
		if (!this.root) return;
		if (this.paneCount >= 4) return;

		const existingPane = this.panes.find((p) => p.id === paneId);
		if (!existingPane) return;

		const newPane: PaneNode = { type: 'pane', id: nextPaneId(), chatId: newChatId };
		const split: SplitNode = {
			type: 'split',
			direction,
			ratio: 0.5,
			children: position === 'before' ? [newPane, existingPane] : [existingPane, newPane],
		};

		const result = replacePaneById(this.root, paneId, split);
		if (result) {
			this.root = result;
			this.focusedPaneId = newPane.id;
		}
	}

	// Adds a chat to the layout using a drop zone position.
	addChatToZone(
		targetPaneId: string,
		chatId: string,
		zone: 'left' | 'right' | 'top' | 'bottom' | 'center',
	): void {
		if (zone === 'center') {
			this.replacePaneChat(targetPaneId, chatId);
			return;
		}
		const direction: SplitDirection =
			zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
		const position: 'before' | 'after' = zone === 'left' || zone === 'top' ? 'before' : 'after';
		this.splitPane(targetPaneId, direction, chatId, position);
	}

	// Replaces the chat displayed in an existing pane.
	replacePaneChat(paneId: string, chatId: string): void {
		if (!this.root) return;
		const replacement: PaneNode = { type: 'pane', id: paneId, chatId };
		const result = replacePaneById(this.root, paneId, replacement);
		if (result) {
			this.root = result;
			this.focusedPaneId = paneId;
		}
	}

	closePane(paneId: string): void {
		if (!this.root) return;

		// If only one pane, disable split mode entirely.
		if (this.root.type === 'pane') {
			this.disable();
			return;
		}

		const result = removePaneById(this.root, paneId);
		if (!result) return;

		// If closing reduced to a single pane, exit split mode.
		if (result.type === 'pane') {
			this.disable();
			return;
		}

		this.root = result;

		// If the focused pane was closed, focus the first remaining pane.
		if (this.focusedPaneId === paneId) {
			const remaining = this.panes;
			this.focusedPaneId = remaining.length > 0 ? remaining[0].id : null;
		}
	}

	// Updates the split ratio for a node found by traversing to the
	// parent of two adjacent panes. Mutates the ratio in place so that
	// tree identity is stable during a resize drag -- rebuilding the tree
	// per pointermove forces every pane subtree to re-render and causes
	// visible jitter.
	setRatioByPath(path: number[], ratio: number): void {
		if (!this.root) return;
		let node: LayoutNode = this.root;
		for (const index of path) {
			if (node.type !== 'split') return;
			node = node.children[index];
		}
		if (node.type !== 'split') return;
		node.ratio = Math.min(0.85, Math.max(0.15, ratio));
	}

	// Convenience: set up a 2x2 grid with 4 chats.
	setGrid(chatIds: string[]): void {
		const ids = chatIds.slice(0, 4);
		if (ids.length < 2) return;

		if (ids.length === 2) {
			const left: PaneNode = { type: 'pane', id: nextPaneId(), chatId: ids[0] };
			const right: PaneNode = { type: 'pane', id: nextPaneId(), chatId: ids[1] };
			this.root = { type: 'split', direction: 'horizontal', ratio: 0.5, children: [left, right] };
			this.focusedPaneId = left.id;
			return;
		}

		if (ids.length === 3) {
			const topLeft: PaneNode = { type: 'pane', id: nextPaneId(), chatId: ids[0] };
			const topRight: PaneNode = { type: 'pane', id: nextPaneId(), chatId: ids[1] };
			const bottom: PaneNode = { type: 'pane', id: nextPaneId(), chatId: ids[2] };
			const topSplit: SplitNode = {
				type: 'split',
				direction: 'horizontal',
				ratio: 0.5,
				children: [topLeft, topRight],
			};
			this.root = {
				type: 'split',
				direction: 'vertical',
				ratio: 0.5,
				children: [topSplit, bottom],
			};
			this.focusedPaneId = topLeft.id;
			return;
		}

		const topLeft: PaneNode = { type: 'pane', id: nextPaneId(), chatId: ids[0] };
		const topRight: PaneNode = { type: 'pane', id: nextPaneId(), chatId: ids[1] };
		const bottomLeft: PaneNode = { type: 'pane', id: nextPaneId(), chatId: ids[2] };
		const bottomRight: PaneNode = { type: 'pane', id: nextPaneId(), chatId: ids[3] };

		const topSplit: SplitNode = {
			type: 'split',
			direction: 'horizontal',
			ratio: 0.5,
			children: [topLeft, topRight],
		};
		const bottomSplit: SplitNode = {
			type: 'split',
			direction: 'horizontal',
			ratio: 0.5,
			children: [bottomLeft, bottomRight],
		};

		this.root = {
			type: 'split',
			direction: 'vertical',
			ratio: 0.5,
			children: [topSplit, bottomSplit],
		};
		this.focusedPaneId = topLeft.id;
	}

	startDrag(chatId: string): void {
		this.draggedChatId = chatId;
		this.draggedPaneId = null;
	}

	startPaneDrag(paneId: string, chatId: string): void {
		this.draggedChatId = chatId;
		this.draggedPaneId = paneId;
	}

	endDrag(): void {
		this.draggedChatId = null;
		this.draggedPaneId = null;
	}

	// Swaps the chats between two panes.
	swapPanes(paneIdA: string, paneIdB: string): void {
		if (!this.root) return;
		const paneA = this.panes.find((p) => p.id === paneIdA);
		const paneB = this.panes.find((p) => p.id === paneIdB);
		if (!paneA || !paneB) return;
		const chatA = paneA.chatId;
		const chatB = paneB.chatId;
		// Rebuild tree immutably via two replacements.
		let result = replacePaneById(this.root, paneIdA, { type: 'pane', id: paneIdA, chatId: chatB });
		if (result)
			result = replacePaneById(result, paneIdB, { type: 'pane', id: paneIdB, chatId: chatA });
		if (result) this.root = result;
	}
}

export function createSplitLayoutStore(): SplitLayoutStore {
	return new SplitLayoutStore();
}
