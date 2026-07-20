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
import { EditorSelection, EditorState, Compartment, Text, type Extension } from '@codemirror/state';
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
import { loadLanguageExtension } from '$lib/files/editor/language-loader.js';
import type { FileSession } from '$lib/files/sessions/file-session.svelte.js';

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
	readonly #handleScroll = (): void => {
		const view = this.#view;
		if (view) this.#captureScroll(view);
	};

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
		const editorState = this.session.editorState ?? this.createState(this.session.content);
		const scrollSnapshot = this.session.editorScrollSnapshot;
		const scrollLeft = this.session.textScrollLeft;
		const scrollTop = this.session.textScrollTop;
		this.#view = new EditorView({
			state: editorState,
			parent,
			scrollTo: scrollSnapshot ?? undefined,
			dispatchTransactions: (transactions, view) => {
				view.update(transactions);
				this.capture(view);
			},
		});
		this.#view.scrollDOM.addEventListener('scroll', this.#handleScroll);
		this.reconfigure();
		void this.applyLanguage();
		const attachedView = this.#view;
		attachedView.requestMeasure({
			key: this,
			read: () => undefined,
			write: () => {
				if (this.#view !== attachedView || lease !== this.#rendererGeneration) return;
				if (!scrollSnapshot || (scrollLeft !== 0 && attachedView.scrollDOM.scrollLeft === 0)) {
					attachedView.scrollDOM.scrollLeft = scrollLeft;
				}
				if (!scrollSnapshot || (scrollTop !== 0 && attachedView.scrollDOM.scrollTop === 0)) {
					attachedView.scrollDOM.scrollTop = scrollTop;
				}
				this.#captureScroll(attachedView);
			},
		});
		requestAnimationFrame(() => {
			if (this.#view === attachedView && lease === this.#rendererGeneration) {
				this.applyRequestedLocation();
			}
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
		this.#captureScroll(view);
		view.scrollDOM.removeEventListener('scroll', this.#handleScroll);
		this.session.editorState = view.state;
		this.session.content = this.#serializeDocument(view.state.doc);
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

	replaceContentFromDisk(content: string): void {
		const view = this.#view;
		const previousState = view?.state ?? this.session.editorState;
		const previousSelection = previousState?.selection.main;
		const nextDocument = normalizedDocument(content);
		const anchor = Math.min(previousSelection?.anchor ?? 0, nextDocument.length);
		const head = Math.min(previousSelection?.head ?? anchor, nextDocument.length);
		const scrollLeft = view?.scrollDOM.scrollLeft ?? this.session.textScrollLeft;
		const scrollTop = view?.scrollDOM.scrollTop ?? this.session.textScrollTop;
		const nextState = this.createState(nextDocument, EditorSelection.single(anchor, head));

		this.session.baseline = content;
		this.session.content = content;
		this.session.dirty = false;
		this.#lineSeparator = lineSeparatorFor(content);
		this.#baselineDocument = nextDocument;
		this.session.editorScrollSnapshot = null;

		if (!view) {
			this.session.editorState = previousState ? nextState : null;
			return;
		}

		this.session.editorState = nextState;
		view.setState(nextState);
		this.reconfigure();
		void this.applyLanguage();
		this.session.textScrollLeft = scrollLeft;
		this.session.textScrollTop = scrollTop;
		requestAnimationFrame(() => {
			if (this.#view !== view) return;
			view.scrollDOM.scrollLeft = scrollLeft;
			view.scrollDOM.scrollTop = scrollTop;
			this.#captureScroll(view);
		});
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

	private createState(content: string | Text, selection?: EditorSelection): EditorState {
		const editorState = EditorState.create({
			doc: content,
			selection,
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
		if (this.session.readOnly || this.session.refreshing) {
			extensions.push(EditorState.readOnly.of(true));
		}
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

	private capture(view: EditorView): void {
		this.session.editorState = view.state;
		this.#baselineDocument ??= normalizedDocument(this.session.baseline);
		this.session.dirty = !view.state.doc.eq(this.#baselineDocument);
		this.#captureScroll(view);
	}

	#captureScroll(view: EditorView): void {
		this.session.editorScrollSnapshot = view.scrollSnapshot();
		this.session.textScrollLeft = view.scrollDOM.scrollLeft;
		this.session.textScrollTop = view.scrollDOM.scrollTop;
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
