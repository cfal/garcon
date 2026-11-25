export class BoardReorderState<Item extends { id: string }> {
	#sourceId: string | null = null;
	overId = $state<string | null>(null);

	constructor(
		private readonly items: () => readonly Item[],
		private readonly locked: () => boolean,
		private readonly commit: (items: Item[]) => void,
	) {}

	start(event: DragEvent, id: string): void {
		if (this.locked()) {
			event.preventDefault();
			return;
		}
		this.#sourceId = id;
		event.dataTransfer?.setData('text/plain', id);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
	}

	over(event: DragEvent, id: string): void {
		if (!this.#sourceId || this.#sourceId === id || this.locked()) return;
		event.preventDefault();
		this.overId = id;
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
	}

	leave(id: string): void {
		if (this.overId === id) this.overId = null;
	}

	drop(event: DragEvent, targetId: string): void {
		event.preventDefault();
		const sourceId = this.#sourceId;
		this.clear();
		if (!sourceId || sourceId === targetId || this.locked()) return;
		const items = this.items();
		const sourceIndex = items.findIndex((item) => item.id === sourceId);
		const targetIndex = items.findIndex((item) => item.id === targetId);
		if (sourceIndex < 0 || targetIndex < 0) return;
		const next = [...items];
		const [moved] = next.splice(sourceIndex, 1);
		next.splice(targetIndex, 0, moved!);
		this.commit(next);
	}

	clear(): void {
		this.#sourceId = null;
		this.overId = null;
	}
}
