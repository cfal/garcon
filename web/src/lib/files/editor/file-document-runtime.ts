import { history, isolateHistory, redo, undo } from '@codemirror/commands';
import { diff } from '@codemirror/merge';
import {
	Annotation,
	ChangeSet,
	EditorSelection,
	EditorState,
	Text,
	Transaction,
	type StateCommand,
	type TransactionSpec,
} from '@codemirror/state';
import type {
	FileDocumentRuntimePort,
	FileDocumentState,
} from '$lib/files/documents/file-document-state.svelte.js';
import {
	fileTextMetadata,
	type FileTextMetadata,
} from '$lib/files/documents/file-text-metadata.js';

const mirroredDocumentChange = Annotation.define<string>();

export interface FileDocumentViewAdapter {
	readonly id: string;
	currentState(): EditorState;
	applySourceTransactions(transactions: readonly Transaction[]): void;
	applyDocumentSpec(spec: TransactionSpec): void;
	replaceDocument(spec: TransactionSpec): void;
}

export class FileDocumentRuntime implements FileDocumentRuntimePort {
	#canonical: EditorState;
	readonly #views = new Map<string, FileDocumentViewAdapter>();
	#lastOrigin: string | null = null;
	#serialized: { doc: Text; separator: string; content: string } | null = null;
	#baseline: { content: string; doc: Text; metadata: FileTextMetadata };

	constructor(
		readonly document: FileDocumentState,
		content: string,
	) {
		this.#canonical = this.#createCanonicalState(normalizeDocument(content));
		this.#baseline = this.#normalizeBaseline();
		Object.assign(document, fileTextMetadata(content));
		document.setStoredContent(this.content());
		document.editorRuntime = this;
	}

	get canonicalState(): EditorState {
		return this.#canonical;
	}

	content(): string {
		const doc = this.#canonical.doc;
		const separator = this.document.lineSeparator;
		if (this.#serialized?.doc !== doc || this.#serialized.separator !== separator) {
			const normalized = doc.toString();
			this.#serialized = {
				doc,
				separator,
				content: separator === '\n' ? normalized : normalized.replaceAll('\n', separator),
			};
		}
		return this.#serialized.content;
	}

	register(adapter: FileDocumentViewAdapter): () => void {
		this.#views.set(adapter.id, adapter);
		return () => {
			if (this.#views.get(adapter.id) === adapter) this.#views.delete(adapter.id);
		};
	}

	dispatchSource(adapter: FileDocumentViewAdapter, transactions: readonly Transaction[]): void {
		if (this.#views.get(adapter.id) !== adapter) return;
		let expected = adapter.currentState();
		if (!expected.doc.eq(this.#canonical.doc)) return;
		for (const transaction of transactions) {
			if (transaction.startState !== expected) return;
			expected = transaction.state;
		}
		for (const transaction of transactions) {
			if (!transaction.docChanged) {
				adapter.applySourceTransactions([transaction]);
				continue;
			}

			const originChanged = this.#lastOrigin !== null && this.#lastOrigin !== adapter.id;
			const selection = clampSelection(
				transaction.startState.selection,
				this.#canonical.doc.length,
			);
			this.#canonical = this.#canonical.update({
				selection,
				annotations: Transaction.addToHistory.of(false),
			}).state;
			const userEvent = transaction.annotation(Transaction.userEvent);
			const historyAdmission = transaction.annotation(Transaction.addToHistory);
			const sourceIsolation = transaction.annotation(isolateHistory);
			const annotations = [
				mirroredDocumentChange.of(adapter.id),
				Transaction.time.of(transaction.annotation(Transaction.time) ?? Date.now()),
				...(historyAdmission === undefined ? [] : [Transaction.addToHistory.of(historyAdmission)]),
				...(sourceIsolation ? [isolateHistory.of(sourceIsolation)] : []),
				...(originChanged ? [isolateHistory.of('before' as const)] : []),
			];
			const canonicalTransaction = this.#canonical.update({
				changes: transaction.changes,
				selection: transaction.newSelection,
				userEvent:
					originChanged && userEvent === 'input.type.compose'
						? 'input.type.compose.start'
						: userEvent,
				annotations,
			});
			this.#canonical = canonicalTransaction.state;
			this.#lastOrigin = adapter.id;
			adapter.applySourceTransactions([transaction]);
			this.#broadcast(adapter.id, canonicalTransaction, false);
			this.#documentChanged();
		}
	}

	undo(viewId: string): boolean {
		return this.#runHistoryCommand(viewId, undo);
	}

	redo(viewId: string): boolean {
		return this.#runHistoryCommand(viewId, redo);
	}

	applyUserEdit(content: string): void {
		const normalized = normalizeDocument(content);
		if (this.#canonical.doc.eq(normalized)) return;
		Object.assign(this.document, fileTextMetadata(content));
		const transaction = this.#canonical.update({
			changes: documentChanges(this.#canonical.doc.toString(), normalized.toString()),
			userEvent: 'input',
			annotations: isolateHistory.of('full'),
		});
		this.#canonical = transaction.state;
		this.#lastOrigin = null;
		this.#broadcast('', transaction, false);
		this.#documentChanged();
	}

	synchronizeDocument(content: string): void {
		const normalized = normalizeDocument(content);
		const metadata = fileTextMetadata(content);
		if (
			this.#canonical.doc.eq(normalized) &&
			this.document.lineSeparator === metadata.lineSeparator
		) {
			return;
		}
		Object.assign(this.document, metadata);
		this.#replaceDocument(normalized);
		this.#documentChanged();
	}

	acceptBaseline(content: string): void {
		this.document.baseline = content;
		this.document.dirty = !this.#matchesBaseline();
	}

	replaceFromDisk(content: string): void {
		Object.assign(this.document, fileTextMetadata(content));
		this.document.baseline = content;
		this.#replaceDocument(normalizeDocument(content));
		this.document.dirty = false;
		this.document.bufferVersion += 1;
		this.#baseline = this.#normalizeBaseline();
		this.document.notifyChanged();
	}

	#replaceDocument(content: Text): void {
		const previous = this.#canonical.doc;
		const changes = documentChanges(previous.toString(), content.toString());
		this.#canonical = this.#createCanonicalState(content);
		this.#lastOrigin = null;
		for (const adapter of this.#views.values()) {
			const current = adapter.currentState();
			adapter.replaceDocument({
				changes,
				selection: current.selection.map(changes, 1),
				annotations: [Transaction.addToHistory.of(false), mirroredDocumentChange.of('disk')],
				filter: false,
			});
		}
	}

	#runHistoryCommand(viewId: string, command: StateCommand): boolean {
		const source = this.#views.get(viewId);
		if (!source || source.currentState().facet(EditorState.readOnly)) return false;
		let result: Transaction | null = null;
		const handled = command({
			state: this.#canonical,
			dispatch: (transaction) => {
				result = transaction;
			},
		});
		if (!handled || !result) return false;
		const transaction = result as Transaction;
		this.#canonical = transaction.state;
		this.#lastOrigin = viewId;
		this.#broadcast(viewId, transaction, true);
		this.#documentChanged();
		return true;
	}

	#broadcast(sourceId: string, transaction: Transaction, useSourceSelection: boolean): void {
		for (const adapter of this.#views.values()) {
			const source = adapter.id === sourceId;
			if (source && !useSourceSelection) continue;
			const current = adapter.currentState();
			const selection = source
				? clampSelection(transaction.newSelection, transaction.newDoc.length)
				: current.selection.map(transaction.changes);
			adapter.applyDocumentSpec({
				changes: transaction.changes,
				selection,
				scrollIntoView: source && transaction.scrollIntoView,
				annotations: [Transaction.addToHistory.of(false), mirroredDocumentChange.of(sourceId)],
				filter: false,
			});
		}
	}

	#documentChanged(): void {
		this.document.bufferVersion += 1;
		this.document.dirty = !this.#matchesBaseline();
		this.document.notifyChanged();
	}

	#matchesBaseline(): boolean {
		if (this.#baseline.content !== this.document.baseline)
			this.#baseline = this.#normalizeBaseline();
		const doc = this.#canonical.doc;
		return (
			doc.eq(this.#baseline.doc) &&
			!this.#baseline.metadata.mixedLineEndings &&
			(doc.lines === 1 || this.document.lineSeparator === this.#baseline.metadata.lineSeparator)
		);
	}

	#normalizeBaseline(): { content: string; doc: Text; metadata: FileTextMetadata } {
		const content = this.document.baseline;
		return { content, doc: normalizeDocument(content), metadata: fileTextMetadata(content) };
	}

	#createCanonicalState(content: Text): EditorState {
		return EditorState.create({
			doc: content,
			extensions: [EditorState.allowMultipleSelections.of(true), history({ minDepth: 100 })],
		});
	}
}

export function clampSelection(selection: EditorSelection, length: number): EditorSelection {
	return EditorSelection.create(
		selection.ranges.map((range) =>
			EditorSelection.range(Math.min(range.anchor, length), Math.min(range.head, length)),
		),
		Math.min(selection.mainIndex, selection.ranges.length - 1),
	);
}

function normalizeDocument(content: string): Text {
	return Text.of(content.split(/\r\n?|\n/));
}

function documentChanges(previous: string, next: string): ChangeSet {
	return ChangeSet.of(
		diff(previous, next, { scanLimit: 500, timeout: 20 }).map((change) => ({
			from: change.fromA,
			to: change.toA,
			insert: next.slice(change.fromB, change.toB),
		})),
		previous.length,
	);
}

export function documentPosition(doc: Text, line: number, column: number): number {
	const lineInfo = doc.line(Math.max(1, Math.min(line, doc.lines)));
	return Math.min(lineInfo.from + Math.max(0, column - 1), lineInfo.to);
}
