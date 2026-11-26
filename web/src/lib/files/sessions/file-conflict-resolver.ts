import * as m from '$lib/paraglide/messages.js';
import type { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import type {
	FileDiskSnapshot,
	FileDocumentIoCoordinator,
} from '$lib/files/persistence/file-document-io-coordinator.js';
import type { FileViewSession } from './file-view-session.svelte.js';
import type {
	FileConflictDecision,
	FileDialogCoordinator,
	FileOverwriteRequest,
} from './file-dialog-coordinator.svelte.js';

export class FileConflictResolver {
	constructor(
		private readonly options: {
			dialogs: FileDialogCoordinator;
			getSession(id: string): FileViewSession | null;
			commitLoadedContent: FileDocumentIoCoordinator['commitLoadedContent'];
			settle(document: FileDocumentState): void;
		},
	) {}

	confirm(
		session: FileViewSession,
		disk: FileDiskSnapshot,
		allowOwnedMutation = false,
	): Promise<FileConflictDecision> {
		return this.options.dialogs.serialize(async () => {
			const snapshot: FileOverwriteRequest = {
				sessionId: session.id,
				fileName: session.fileName,
				baseContent: session.baseline,
				localContent: session.document.currentContent(),
				diskContent: disk.content,
				diskRevision: disk.revision,
				localBufferVersion: session.document.bufferVersion,
				lineSeparator: session.document.lineSeparator,
			};
			const cancelled = (): FileConflictDecision => ({
				choice: 'cancel',
				snapshot,
				resolvedContent: snapshot.localContent,
			});
			const canResolve = () =>
				this.options.getSession(session.id) === session &&
				(allowOwnedMutation || !session.document.mutationGuarded);
			if (!canResolve()) return cancelled();
			const decision = await this.options.dialogs.askOverwrite(snapshot);
			if (
				decision.choice !== 'cancel' &&
				(!canResolve() || session.document.bufferVersion !== decision.snapshot.localBufferVersion)
			) {
				session.saveError = m.file_conflict_buffer_changed();
				return cancelled();
			}
			if (decision.choice === 'accept-disk') {
				this.options.commitLoadedContent(session, {
					kind: 'text',
					content: decision.snapshot.diskContent,
					revision: decision.snapshot.diskRevision,
				});
				this.options.settle(session.document);
			}
			return this.options.getSession(session.id) === session ? decision : cancelled();
		});
	}

	apply(session: FileViewSession, decision: FileConflictDecision): boolean {
		if (session.document.bufferVersion !== decision.snapshot.localBufferVersion) {
			session.saveError = m.file_conflict_buffer_changed();
			return false;
		}
		if (decision.resolvedContent !== session.document.currentContent()) {
			session.document.applyUserEdit(decision.resolvedContent);
		}
		return true;
	}
}
