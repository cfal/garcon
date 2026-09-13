import { describe, expect, it, vi } from 'vitest';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
import { promoteDirtyPreviewViews } from '$lib/files/sessions/file-view-policy.js';

describe('file view policy', () => {
	it('pins a preview when its shared document becomes dirty', () => {
		const document = new FileDocumentState(
			{ canonicalFileRootPath: '/workspace', normalizedRelativePath: 'file.ts' },
			'key',
		);
		document.dirty = true;
		const session = new FileViewSession(document);
		session.preview = true;
		session.pinned = false;
		const promoted = vi.fn();

		promoteDirtyPreviewViews(document, () => session, promoted);

		expect(session.preview).toBe(false);
		expect(session.pinned).toBe(true);
		expect(promoted).toHaveBeenCalledWith(session);
	});
});
