export function indexedDbRequest<T>(
	request: IDBRequest<T>,
	fallbackMessage = 'IndexedDB request failed',
): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error(fallbackMessage));
	});
}

export function indexedDbTransactionCompletion(
	transaction: IDBTransaction,
	messages: { aborted?: string; failed?: string } = {},
): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error(messages.aborted ?? 'IndexedDB transaction aborted'));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error(messages.failed ?? 'IndexedDB transaction failed'));
	});
}
