export interface ReorderWrite<TList extends string> {
	list: TList;
	oldOrder: string[];
	newOrder: string[];
}

/**
 * Serializes reorder writes and coalesces queued updates per list.
 * Keeps only the latest pending reorder for each list while a write is in flight.
 */
export function createReorderWriteQueue<TList extends string>(
	write: (task: ReorderWrite<TList>) => Promise<void>,
	onError: (error: unknown, task: ReorderWrite<TList>) => void,
) {
	const pendingByList = new Map<TList, ReorderWrite<TList>>();
	const pendingOrder: TList[] = [];
	let draining = false;

	function popNext(): ReorderWrite<TList> | null {
		while (pendingOrder.length > 0) {
			const list = pendingOrder.shift()!;
			const task = pendingByList.get(list);
			if (!task) continue;
			pendingByList.delete(list);
			return task;
		}
		return null;
	}

	async function drain() {
		draining = true;
		try {
			while (true) {
				const task = popNext();
				if (!task) break;
				try {
					await write(task);
				} catch (error) {
					onError(error, task);
				}
			}
		} finally {
			draining = false;
			// Handles enqueue-after-empty races without dropping tasks.
			if (pendingByList.size > 0 && !draining) {
				void drain();
			}
		}
	}

	return {
		enqueue(task: ReorderWrite<TList>) {
			const hasPendingForList = pendingByList.has(task.list);
			pendingByList.set(task.list, task);
			if (!hasPendingForList) pendingOrder.push(task.list);
			if (!draining) void drain();
		},
	};
}
