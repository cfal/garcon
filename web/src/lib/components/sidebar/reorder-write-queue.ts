export interface PerListWrite<TList extends string> {
	list: TList;
	onSuccess?: () => void;
	onFailure?: () => void;
}

/**
 * Serializes writes per list while allowing independent lists to drain concurrently.
 * Reorder writes are relative operations, so each user drop must be preserved.
 */
export function createPerListWriteQueue<
	TList extends string,
	TTask extends PerListWrite<TList>,
>(
	write: (task: TTask) => Promise<void>,
	onError: (error: unknown, task: TTask) => void,
) {
	const pendingByList = new Map<TList, TTask[]>();
	const drainingLists = new Set<TList>();

	async function drain(list: TList) {
		drainingLists.add(list);
		try {
			while (true) {
				const queue = pendingByList.get(list);
				const task = queue?.shift() ?? null;
				if (!task) break;
				if (queue && queue.length === 0) pendingByList.delete(list);
				try {
					await write(task);
					task.onSuccess?.();
					} catch (error) {
						onError(error, task);
						task.onFailure?.();
				}
			}
		} finally {
			drainingLists.delete(list);
			if ((pendingByList.get(list)?.length ?? 0) > 0) void drain(list);
		}
	}

	return {
		enqueue(task: TTask) {
			const queue = pendingByList.get(task.list) ?? [];
			queue.push(task);
			pendingByList.set(task.list, queue);
			if (!drainingLists.has(task.list)) void drain(task.list);
		},
	};
}
