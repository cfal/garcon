// Clipboard helpers for current browser runtimes with the async Clipboard API.
export async function copyToClipboard(
	text: string,
	_container?: Element,
): Promise<boolean> {
	if (!text) return false;
	if (!navigator.clipboard?.writeText) return false;
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
