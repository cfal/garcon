import type { FileDocumentContentKind } from '$lib/files/documents/file-document-state.svelte.js';
import type { FileRendererMode } from '$lib/files/sessions/file-view-session.svelte.js';
import { fileExtension, isImageFilePath } from '$lib/utils/file-kind.js';

export type FileOpenMode = 'auto' | 'code' | 'markdown' | 'image';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

export function resolveFileRendererMode(path: string, requested: FileOpenMode): FileRendererMode {
	if (requested !== 'auto') return requested;
	if (isImageFilePath(path)) return 'image';
	return MARKDOWN_EXTENSIONS.has(fileExtension(path)) ? 'markdown' : 'code';
}

export function fileContentKind(path: string, mode: FileRendererMode): FileDocumentContentKind {
	if (mode === 'image') return 'image';
	return MARKDOWN_EXTENSIONS.has(fileExtension(path)) ? 'markdown' : 'text';
}

export function navigationViewPreference(mode: FileRendererMode): 'source' | 'preview' | 'image' {
	switch (mode) {
		case 'image':
			return 'image';
		case 'markdown':
			return 'preview';
		case 'code':
			return 'source';
	}
}

export function rendererModeForNavigation(
	preference: ReturnType<typeof navigationViewPreference>,
): FileRendererMode {
	switch (preference) {
		case 'image':
			return 'image';
		case 'preview':
			return 'markdown';
		case 'source':
			return 'code';
	}
}
