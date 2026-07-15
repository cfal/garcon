import type { FileSession } from './file-session.svelte.js';

export function shouldWaitForFileRenderer(
	session: Pick<FileSession, 'rendererMode' | 'loading' | 'loadError'> | null,
): boolean {
	return Boolean(session?.rendererMode === 'code' && !session.loading && !session.loadError);
}
