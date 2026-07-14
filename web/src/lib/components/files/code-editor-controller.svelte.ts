import {
	EditorView,
	lineNumbers,
	highlightActiveLineGutter,
	highlightSpecialChars,
	drawSelection,
	dropCursor,
	highlightActiveLine,
	keymap,
} from '@codemirror/view';
import { EditorState, Compartment, Text, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
	foldGutter,
	indentOnInput,
	syntaxHighlighting,
	defaultHighlightStyle,
	bracketMatching,
	foldKeymap,
} from '@codemirror/language';
import { unifiedMergeView } from '@codemirror/merge';
import { oneDark } from '@codemirror/theme-one-dark';
import { loadLanguageExtension } from './language-loader.js';
import type { FileSession } from './file-session.svelte.js';

export interface EditorPresentationSettings {
	readonly isDark: boolean;
	readonly wordWrap: boolean;
	readonly showLineNumbers: boolean;
	readonly fontSize: number;
}

function normalizedDocument(content: string): Text {
	return Text.of(content.split(/\r\n?|\n/));
}

function lineSeparatorFor(content: string): '\n' | '\r\n' {
	return content.includes('\r\n') ? '\r\n' : '\n';
}

export class CodeEditorController {
	#view: EditorView | null = null;
	#languageCompartment = new Compartment();
	#dynamicCompartment = new Compartment();
	#languageGeneration = 0;
	#rendererGeneration = 0;
	#baselineDocument: Text | null = null;
	#lineSeparator: '\n' | '\r\n';

	constructor(
		readonly session: FileSession,
		private readonly settings: EditorPresentationSettings,
	) {
		this.#lineSeparator = lineSeparatorFor(session.content || session.baseline);
	}

	get isAttached(): boolean {
		return this.#view !== null;
	}

	attach(parent: HTMLElement): number {
		if (this.#view) throw new Error('File editor renderer is already attached');
		const lease = ++this.#rendererGeneration;
		const editorState = this.session.editorState ?? this.createInitialState();
		this.#view = new EditorView({
			state: editorState,
			parent,
			dispatchTransactions: (transactions, view) => {
				view.update(transactions);
				this.capture(view.state);
			},
		});
		this.reconfigure();
		void this.applyLanguage();
		requestAnimationFrame(() => {
			if (!this.#view || lease !== this.#rendererGeneration) return;
			this.#view.scrollDOM.scrollTop = this.session.textScrollTop;
			this.applyRequestedLocation();
		});
		return lease;
	}

	detach(lease?: number): void {
		if (lease !== undefined && lease !== this.#rendererGeneration) return;
		this.#detachCurrent();
	}

	prepareRendererTransfer(): void {
		this.#rendererGeneration += 1;
		this.#detachCurrent();
	}

	#detachCurrent(): void {
		const view = this.#view;
		if (!view) return;
		this.session.editorState = view.state;
		this.session.content = this.#serializeDocument(view.state.doc);
		this.session.textScrollTop = view.scrollDOM.scrollTop;
		view.destroy();
		this.#view = null;
	}

	reconfigure(): void {
		this.#view?.dispatch({
			effects: this.#dynamicCompartment.reconfigure(this.dynamicExtensions()),
		});
	}

	focus(): void {
		this.#view?.focus();
	}

	currentContent(): string {
		const document = this.#view?.state.doc ?? this.session.editorState?.doc;
		if (document) this.session.content = this.#serializeDocument(document);
		return this.session.content;
	}

	acceptBaseline(content: string): void {
		this.session.baseline = content;
		this.#lineSeparator = lineSeparatorFor(content);
		this.#baselineDocument = normalizedDocument(content);
		const document = this.#view?.state.doc ?? this.session.editorState?.doc;
		this.session.dirty = document
			? !document.eq(this.#baselineDocument)
			: this.session.content !== content;
	}

	resetContent(content: string): void {
		this.session.baseline = content;
		this.session.content = content;
		this.session.editorState = null;
		this.session.dirty = false;
		this.#lineSeparator = lineSeparatorFor(content);
		this.#baselineDocument = normalizedDocument(content);
	}

	applyRequestedLocation(): void {
		const view = this.#view;
		const lineNumber = this.session.requestedLine;
		if (!view || !lineNumber || lineNumber < 1) return;
		const line = Math.max(1, Math.min(lineNumber, view.state.doc.lines));
		const lineInfo = view.state.doc.line(line);
		const columnOffset = Math.max(0, (this.session.requestedColumn ?? 1) - 1);
		const position = Math.min(lineInfo.from + columnOffset, lineInfo.to);
		view.dispatch({
			selection: { anchor: position },
			effects: EditorView.scrollIntoView(position, { y: 'start' }),
		});
		this.session.requestedLine = null;
		this.session.requestedColumn = null;
	}

	dispose(): void {
		this.#rendererGeneration += 1;
		this.detach();
		this.#languageGeneration += 1;
	}

	private createInitialState(): EditorState {
		const editorState = EditorState.create({
			doc: this.session.content,
			extensions: [
				highlightActiveLineGutter(),
				highlightSpecialChars(),
				history(),
				drawSelection(),
				dropCursor(),
				indentOnInput(),
				syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
				bracketMatching(),
				highlightActiveLine(),
				foldGutter(),
				keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
				this.#languageCompartment.of([]),
				this.#dynamicCompartment.of(this.dynamicExtensions()),
			],
		});
		this.#baselineDocument ??= normalizedDocument(this.session.baseline);
		return editorState;
	}

	private dynamicExtensions(): Extension[] {
		const extensions: Extension[] = [
			EditorView.theme({
				'&': { fontSize: `${this.settings.fontSize}px` },
				'.cm-content, .cm-gutters': {
					fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
				},
			}),
		];
		if (this.settings.isDark) extensions.push(oneDark);
		if (this.settings.showLineNumbers) extensions.push(lineNumbers());
		if (this.settings.wordWrap) extensions.push(EditorView.lineWrapping);
		if (this.session.readOnly) extensions.push(EditorState.readOnly.of(true));
		if (this.session.showDiff && this.session.oldContent !== null) {
			extensions.push(
				unifiedMergeView({
					original: this.session.oldContent,
					gutter: true,
					highlightChanges: true,
				}),
			);
		}
		return extensions;
	}

	private capture(editorState: EditorState): void {
		this.session.editorState = editorState;
		this.#baselineDocument ??= normalizedDocument(this.session.baseline);
		this.session.dirty = !editorState.doc.eq(this.#baselineDocument);
	}

	#serializeDocument(document: Text): string {
		const content = document.toString();
		return this.#lineSeparator === '\r\n' ? content.replaceAll('\n', '\r\n') : content;
	}

	private async applyLanguage(): Promise<void> {
		const generation = ++this.#languageGeneration;
		const extensions = await loadLanguageExtension({ filePath: this.session.relativePath });
		if (generation !== this.#languageGeneration || !this.#view) return;
		this.#view.dispatch({ effects: this.#languageCompartment.reconfigure(extensions) });
	}
}
