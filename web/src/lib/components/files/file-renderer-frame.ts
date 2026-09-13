import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';

export function shouldWaitForFileRenderer(
	session: Pick<FileViewSession, 'rendererMode' | 'loading' | 'loadError'> | null,
): boolean {
	return Boolean(session?.rendererMode === 'code' && !session.loading && !session.loadError);
}
