export function lazyRenderer<T>(load: () => Promise<{ default: T }>): () => Promise<T> {
	let cached: Promise<T> | null = null;
	return () =>
		(cached ??= load()
			.then((module) => module.default)
			.catch((error) => {
				cached = null;
				throw error;
			}));
}
