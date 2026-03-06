// Clipboard helpers for environments where the async Clipboard API
// may be unavailable (insecure contexts, older browsers, iframes).

/** Copies text via a hidden textarea and execCommand('copy'). */
function copyWithLegacyExecCommand(
	text: string,
	container: Element = document.body,
): boolean {
	const textarea = document.createElement('textarea');
	const previouslyFocused = document.activeElement as HTMLElement | null;
	textarea.value = text;
	textarea.setAttribute('readonly', '');
	textarea.style.position = 'fixed';
	textarea.style.opacity = '0';
	textarea.style.left = '-9999px';
	textarea.style.pointerEvents = 'none';
	container.appendChild(textarea);
	textarea.focus();
	textarea.select();
	textarea.setSelectionRange(0, text.length);
	let copied = false;
	try {
		copied = document.execCommand('copy');
	} catch {
		copied = false;
	} finally {
		container.removeChild(textarea);
		previouslyFocused?.focus?.();
	}
	return copied;
}

/** Copies text with the async Clipboard API, falling back to execCommand.
 *  Callers inside focus-trapped contexts (e.g. dialogs) should pass their
 *  container so the legacy fallback textarea can receive focus. */
export async function copyToClipboard(
	text: string,
	container?: Element,
): Promise<boolean> {
	if (!text) return false;

	// Prefer the modern async Clipboard API.
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Fall through to legacy path.
		}
	}

	// Legacy fallback for runtimes without the async API.
	return copyWithLegacyExecCommand(text, container);
}
