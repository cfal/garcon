import type { FileViewSession } from './file-view-session.svelte.js';

export type FileDestructiveReason = 'close' | 'replace-dialog' | 'refresh';
export type FileCloseRelease = () => void;

type ConfirmDocument = (
	session: FileViewSession,
	reason: FileDestructiveReason,
) => Promise<boolean>;

export class FileCloseCoordinator {
	readonly #reservedViewCounts = new Map<string, number>();

	constructor(private readonly getSession: (viewId: string) => FileViewSession | null) {}

	async prepare(
		viewIds: readonly string[],
		reason: Exclude<FileDestructiveReason, 'refresh'>,
		confirmDocument: ConfirmDocument,
	): Promise<FileCloseRelease | null> {
		const release = this.#reserve(viewIds);
		try {
			if (await this.confirm(viewIds, reason, confirmDocument)) return release;
			release();
			return null;
		} catch (error) {
			release();
			throw error;
		}
	}

	async confirm(
		viewIds: readonly string[],
		reason: FileDestructiveReason,
		confirmDocument: ConfirmDocument,
	): Promise<boolean> {
		const requested = new Set(viewIds);
		const candidates = new Map<string, FileViewSession>();
		for (const viewId of viewIds) {
			const session = this.getSession(viewId);
			if (!session) continue;
			const closesDocument = [...session.document.viewIds].every(
				(id) => requested.has(id) || this.#reservedViewCounts.has(id),
			);
			if (reason === 'refresh' || closesDocument) candidates.set(session.documentId, session);
		}
		const confirmed: Array<{
			session: FileViewSession;
			bufferVersion: number;
		}> = [];
		for (const session of candidates.values()) {
			if (!(await confirmDocument(session, reason))) return false;
			confirmed.push({ session, bufferVersion: session.document.bufferVersion });
		}
		return confirmed.every(
			({ session, bufferVersion }) =>
				this.getSession(session.id) === session &&
				session.document.bufferVersion === bufferVersion &&
				!session.dirty &&
				!session.document.mutationGuarded,
		);
	}

	#reserve(viewIds: readonly string[]): FileCloseRelease {
		const reserved = [...new Set(viewIds)];
		for (const viewId of reserved) {
			this.#reservedViewCounts.set(viewId, (this.#reservedViewCounts.get(viewId) ?? 0) + 1);
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			for (const viewId of reserved) {
				const count = this.#reservedViewCounts.get(viewId) ?? 0;
				if (count <= 1) this.#reservedViewCounts.delete(viewId);
				else this.#reservedViewCounts.set(viewId, count - 1);
			}
		};
	}
}
