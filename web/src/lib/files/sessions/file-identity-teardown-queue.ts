export class FileIdentityTeardownQueue {
	readonly #operations = new Map<string, Promise<void>>();

	async drain(identityKey: string): Promise<void> {
		let operation = this.#operations.get(identityKey);
		while (operation) {
			await operation;
			operation = this.#operations.get(identityKey);
		}
	}

	async run(identityKey: string, teardown: () => void | Promise<void>): Promise<void> {
		const previous = this.#operations.get(identityKey) ?? Promise.resolve();
		const operation = previous.catch(() => undefined).then(teardown);
		this.#operations.set(identityKey, operation);
		try {
			await operation;
		} finally {
			if (this.#operations.get(identityKey) === operation) this.#operations.delete(identityKey);
		}
	}
}
