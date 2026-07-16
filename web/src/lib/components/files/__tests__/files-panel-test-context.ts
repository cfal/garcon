import type { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
import type { SingletonSurfaceRegistry } from '$lib/workspace/singleton-surfaces.svelte.js';

interface FilesPanelTestContext {
	fileSessions: FileSessionRegistry;
	singletonSurfaces: SingletonSurfaceRegistry;
}

let current: FilesPanelTestContext | null = null;

export function setFilesPanelTestContext(context: FilesPanelTestContext): void {
	current = context;
}

export function getFilesPanelTestContext(): FilesPanelTestContext {
	if (!current) throw new Error('FilesPanel test context has not been configured');
	return current;
}
