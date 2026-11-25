export function observeSetting<T>(read: () => T, onRead: (value: T) => void): () => void {
	return $effect.root(() => {
		const value = $derived.by(read);
		$effect(() => {
			onRead(value);
		});
	});
}
