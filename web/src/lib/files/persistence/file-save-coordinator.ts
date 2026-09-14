import { ApiError } from '$lib/api/client.js';
import { saveText } from '$lib/api/files.js';
import * as m from '$lib/paraglide/messages.js';
import type { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import type { FileRevision } from '$shared/file-contracts';

export const FILE_SAVE_TIMEOUT_MS = 30_000;

interface FileSaveCoordinatorOptions {
	saveText: typeof saveText;
	getTimeoutMs(): number;
}

export class FileSaveCoordinator {
	constructor(private readonly options: FileSaveCoordinatorOptions) {}

	async submit(
		document: FileDocumentState,
		content: string,
		controller: AbortController,
		expectedRevision: FileRevision,
	): Promise<void> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				this.options.saveText(
					{
						projectPath: document.canonicalFileRootPath,
						filePath: document.relativePath,
						content,
						expectedRevision,
						conflictResolution: 'reject',
					},
					{ signal: controller.signal, timeoutMs: null },
				),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => {
						reject(new Error(m.file_save_unconfirmed()));
						controller.abort();
					}, this.options.getTimeoutMs());
				}),
			]);
			if (controller.signal.aborted || document.saveController !== controller) {
				throw new Error(m.file_save_unconfirmed());
			}
			// Acknowledges only the submitted text; edits made during Save remain dirty.
			document.loadedRevision = result.revision;
			if (document.editorRuntime) document.editorRuntime.acceptBaseline(content);
			else {
				document.baseline = content;
				document.dirty = document.currentContent() !== content;
			}
			document.missing = false;
			document.isExternallyStale = false;
			document.refreshError = null;
			document.freshnessError = null;
			document.saveError = null;
			document.recovered = false;
		} finally {
			clearTimeout(timeout);
		}
	}
}

export function isFileRevisionConflict(error: unknown): boolean {
	return error instanceof ApiError && error.errorCode === 'FILE_REVISION_CONFLICT';
}
