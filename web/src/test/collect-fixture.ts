export const FIXTURE_COLLECTION_TIMEOUT_MS = 120_000;

export async function collectFixture<T>(
	work: Promise<T>,
	label: string,
	timeoutMs = FIXTURE_COLLECTION_TIMEOUT_MS,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`Fixture collection timed out: ${label} (${timeoutMs}ms)`)),
				timeoutMs,
			);
		});
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
	}
}
