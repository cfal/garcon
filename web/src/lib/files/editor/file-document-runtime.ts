import { history, isolateHistory, redo, undo } from '@codemirror/commands';
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
	FileDocumentPositionMap,
	FileDocumentRuntimePort,
	FileDocumentState,
} from '$lib/files/documents/file-document-state.svelte.js';
import { fileTextMetadata } from '$lib/files/documents/file-text-metadata.js';

const mirroredDocumentChange = Annotation.define<string>();

export interface FileDocumentViewAdapter {
	readonly id: string;
	currentState(): EditorState;
	applySourceTransactions(transactions: readonly Transaction[]): void;
	applyDocumentSpec(spec: TransactionSpec): void;
}

export class FileDocumentRuntime implements FileDocumentRuntimePort {
	#canonical: EditorState;
	readonly #views = new Map<string, FileDocumentViewAdapter>();
	#lastOrigin: string | null = null;

	constructor(
		readonly document: FileDocumentState,
		content: string,
	) {
		this.#canonical = this.#createCanonicalState(normalizeDocument(content));
		Object.assign(document, fileTextMetadata(content));
		document.setStoredContent(this.#serializeDocument());
		document.editorRuntime = this;
	}

	get canonicalState(): EditorState {
		return this.#canonical;
	}

	content(): string {
		return this.#serializeDocument();
	}

	register(adapter: FileDocumentViewAdapter): () => void {
		this.#views.set(adapter.id, adapter);
		return () => {
			if (this.#views.get(adapter.id) === adapter) this.#views.delete(adapter.id);
		};
	}

	dispatchSource(adapter: FileDocumentViewAdapter, transactions: readonly Transaction[]): void {
		if (this.#views.get(adapter.id) !== adapter) return;
		for (const transaction of transactions) {
			if (transaction.startState !== adapter.currentState()) return;
			if (!transaction.startState.doc.eq(this.#canonical.doc)) return;
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
			this.#documentChanged(positionMapForTransaction(canonicalTransaction));
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
		this.#documentChanged(positionMapForTransaction(transaction));
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
		const positionMap = this.#replaceDocument(normalized);
		this.#documentChanged(positionMap);
	}

	acceptBaseline(content: string): void {
		this.document.baseline = content;
		this.document.dirty = this.content() !== content;
	}

	replaceFromDisk(content: string): void {
		Object.assign(this.document, fileTextMetadata(content));
		this.document.baseline = content;
		const positionMap = this.#replaceDocument(normalizeDocument(content));
		this.document.dirty = false;
		this.document.bufferVersion += 1;
		this.document.setStoredContent(this.content());
		this.document.notifyChanged(positionMap);
	}

	#replaceDocument(content: Text): FileDocumentPositionMap {
		const previous = this.#canonical.doc;
		const changes = documentChanges(previous.toString(), content.toString());
		this.#canonical = this.#createCanonicalState(content);
		this.#lastOrigin = null;
		for (const adapter of this.#views.values()) {
			const current = adapter.currentState();
			adapter.applyDocumentSpec({
				changes,
				selection: current.selection.map(changes, 1),
				annotations: [Transaction.addToHistory.of(false), mirroredDocumentChange.of('disk')],
				filter: false,
			});
		}
		return createPositionMap(previous, this.#canonical.doc, changes, 1);
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
		this.#documentChanged(positionMapForTransaction(transaction));
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

	#documentChanged(positionMap: FileDocumentPositionMap): void {
		this.document.bufferVersion += 1;
		const content = this.content();
		this.document.dirty = content !== this.document.baseline;
		this.document.setStoredContent(content);
		this.document.notifyChanged(positionMap);
	}

	#serializeDocument(): string {
		const content = this.#canonical.doc.toString();
		const separator = this.document.lineSeparator;
		return separator === '\n' ? content : content.replaceAll('\n', separator);
	}

	#createCanonicalState(content: Text): EditorState {
		return EditorState.create({
			doc: content,
			extensions: [EditorState.allowMultipleSelections.of(true), history({ minDepth: 100 })],
		});
	}
}

function clampSelection(selection: EditorSelection, length: number): EditorSelection {
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
	let prefix = 0;
	const sharedLength = Math.min(previous.length, next.length);
	while (prefix < sharedLength && previous.charCodeAt(prefix) === next.charCodeAt(prefix))
		prefix += 1;
	let previousEnd = previous.length;
	let nextEnd = next.length;
	while (
		previousEnd > prefix &&
		nextEnd > prefix &&
		previous.charCodeAt(previousEnd - 1) === next.charCodeAt(nextEnd - 1)
	) {
		previousEnd -= 1;
		nextEnd -= 1;
	}
	return ChangeSet.of(
		{ from: prefix, to: previousEnd, insert: next.slice(prefix, nextEnd) },
		previous.length,
	);
}

function positionMapForTransaction(transaction: Transaction): FileDocumentPositionMap {
	return createPositionMap(transaction.startState.doc, transaction.newDoc, transaction.changes, -1);
}

export function documentPosition(doc: Text, line: number, column: number): number {
	const lineInfo = doc.line(Math.max(1, Math.min(line, doc.lines)));
	return Math.min(lineInfo.from + Math.max(0, column - 1), lineInfo.to);
}

function createPositionMap(
	previous: Text,
	mappedDocument: Text,
	changeSet: ChangeSet,
	cursorAssociation: -1 | 1,
): FileDocumentPositionMap {
	return {
		previousPosition(line, column) {
			return documentPosition(previous, line, column);
		},
		mapRange(from, to) {
			const range = EditorSelection.range(
				Math.max(0, Math.min(from, previous.length)),
				Math.max(0, Math.min(to, previous.length)),
			).map(changeSet, cursorAssociation);
			return { from: range.from, to: range.to };
		},
		nextLocation(position) {
			const mappedPosition = Math.max(0, Math.min(position, mappedDocument.length));
			const lineInfo = mappedDocument.lineAt(mappedPosition);
			return { line: lineInfo.number, column: mappedPosition - lineInfo.from + 1 };
		},
	};
}
