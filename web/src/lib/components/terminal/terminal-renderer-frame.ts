import type { TerminalClientSession } from '$lib/terminal/sessions/terminal-registry.svelte.js';

export function shouldWaitForTerminalRenderer(
	session: Pick<TerminalClientSession, 'runtimeState'> | null,
): boolean {
	return session?.runtimeState === 'ready';
}
