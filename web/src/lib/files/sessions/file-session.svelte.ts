import type { CanonicalFileIdentity } from '$shared/file-contracts';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import {
	FileViewSession,
	defaultImageViewState,
	type FileRendererMode,
	type ImageViewState,
} from '$lib/files/sessions/file-view-session.svelte.js';

export type { FileDocumentContentKind as FileContentKind } from '$lib/files/documents/file-document-state.svelte.js';
export { defaultImageViewState, FileViewSession };
export type { FileRendererMode, ImageViewState };

export class FileSession extends FileViewSession {
	constructor(identity: CanonicalFileIdentity, identityKey: string) {
		super(new FileDocumentState(identity, identityKey));
	}
}
