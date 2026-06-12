export type ActionCallback<TArgs extends unknown[] = []> = (...args: TArgs) => void;

export interface ActionSignal<TArgs extends unknown[] = []> {
	subscribe(callback: ActionCallback<TArgs>): () => void;
	emit(...args: TArgs): void;
}

export function createActionSignal<TArgs extends unknown[] = []>(): ActionSignal<TArgs> {
	const callbacks = new Set<ActionCallback<TArgs>>();

	return {
		subscribe(callback) {
			callbacks.add(callback);
			return () => {
				callbacks.delete(callback);
			};
		},
		emit(...args) {
			for (const callback of callbacks) callback(...args);
		},
	};
}
