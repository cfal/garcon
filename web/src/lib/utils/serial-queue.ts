export class SerialQueue {
	#tail: Promise<void> = Promise.resolve();

	enqueue<T>(operation: () => T | PromiseLike<T>): Promise<T> {
		const turn = this.#tail.then(operation);
		this.#tail = turn.then(
			() => undefined,
			() => undefined,
		);
		return turn;
	}
}
