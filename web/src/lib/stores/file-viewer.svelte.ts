// Coordinates file-viewer requests from any surface (chat links, tool
// renderers, file tree, commands) to the global FileViewerHost. Replaces
// the tab-coupled FileOpenStore with a mode-aware, tab-independent contract.

export type FileViewerSource = 'markdown-link' | 'tool' | 'files-tree' | 'command';

export type FileViewerMode = 'auto' | 'code' | 'image' | 'markdown';

export type FileViewerResolvedMode = 'code' | 'image' | 'markdown';

export interface FileViewerRequest {
	chatId: string;
	projectPath: string;
	relativePath: string;
	source: FileViewerSource;
	preferredMode: FileViewerMode;
	line?: number;
	col?: number;
	requestedAt: number;
}

export interface ActiveFileViewerSession {
	chatId: string;
	projectPath: string;
	relativePath: string;
	mode: FileViewerResolvedMode;
	line?: number;
	col?: number;
	openedAt: number;
}

const IMAGE_EXTENSIONS = new Set([
	'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp',
]);

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

function getExtension(path: string): string {
	const part = path.split('/').pop() ?? path;
	const ext = part.includes('.') ? part.split('.').pop() : '';
	return (ext ?? '').toLowerCase();
}

/** Resolves the effective viewer mode from a path and preferred mode. */
export function resolveViewerMode(
	path: string,
	preferredMode: FileViewerMode,
): FileViewerResolvedMode {
	if (preferredMode !== 'auto') return preferredMode;
	const ext = getExtension(path);
	if (IMAGE_EXTENSIONS.has(ext)) return 'image';
	if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
	return 'code';
}

type OpenInput = Omit<FileViewerRequest, 'preferredMode' | 'requestedAt'>;

export class FileViewerStore {
	/** The current pending request, consumed by FileViewerHost. */
	pending = $state<FileViewerRequest | null>(null);

	openAuto(input: OpenInput): void {
		this.pending = { ...input, preferredMode: 'auto', requestedAt: Date.now() };
	}

	openCode(input: OpenInput): void {
		this.pending = { ...input, preferredMode: 'code', requestedAt: Date.now() };
	}

	openMarkdown(input: OpenInput): void {
		this.pending = { ...input, preferredMode: 'markdown', requestedAt: Date.now() };
	}

	openImage(input: OpenInput): void {
		this.pending = { ...input, preferredMode: 'image', requestedAt: Date.now() };
	}

	consumePending(): FileViewerRequest | null {
		const req = this.pending;
		this.pending = null;
		return req;
	}
}

export function createFileViewerStore(): FileViewerStore {
	return new FileViewerStore();
}
