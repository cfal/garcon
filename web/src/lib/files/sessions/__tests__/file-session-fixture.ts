import type { CanonicalFileIdentity } from '$shared/file-contracts';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';

export class FileSession extends FileViewSession {
	constructor(identity: CanonicalFileIdentity, identityKey: string) {
		super(new FileDocumentState(identity, identityKey));
	}
}
