import * as m from '$lib/paraglide/messages.js';
import {
	EditorView,
	lineNumbers,
	highlightActiveLineGutter,
	highlightSpecialChars,
	drawSelection,
	dropCursor,
	highlightActiveLine,
	getDialog,
	keymap,
} from '@codemirror/view';
import {
	type EditorSelection,
	EditorState,
	Compartment,
	Prec,
	type Extension,
	type Text,
} from '@codemirror/state';
import {
	copyLineDown,
	copyLineUp,
	cursorMatchingBracket,
	deleteLine,
	indentLess,
	indentMore,
	moveLineDown,
	moveLineUp,
	defaultKeymap,
	toggleComment,
} from '@codemirror/commands';
import {
	foldAll,
	foldCode,
	foldGutter,
	foldKeymap,
	indentOnInput,
	syntaxHighlighting,
	defaultHighlightStyle,
	bracketMatching,
	unfoldAll,
	unfoldCode,
} from '@codemirror/language';
import {
	closeSearchPanel,
	gotoLine,
	openSearchPanel,
	search,
	searchKeymap,
	selectNextOccurrence,
} from '@codemirror/search';
import { loadCodeMirrorLanguageForFile } from '$lib/files/editor/language-loader.js';
import {
	createFileSearchPanel,
	fileSearchScope,
	openFileReplacePanel,
} from '$lib/files/editor/file-search-panel.js';
import { fileExtension } from '$lib/utils/file-kind.js';
import {
	FileDocumentRuntime,
	clampSelection,
	documentPosition,
	type FileDocumentViewAdapter,
} from '$lib/files/editor/file-document-runtime.js';
import { FileVimMode } from '$lib/files/editor/file-vim-mode.svelte.js';
import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
import { editorThemeExtension, type EditorThemeId } from '$lib/files/editor/editor-themes.js';

export interface EditorPresentationSettings {
	readonly editorThemeId: EditorThemeId;
	readonly wordWrap: boolean;
	readonly showLineNumbers: boolean;
	readonly fontSize: number;
	readonly vimMode?: boolean;
}

export type FileEditorCommand =
	| 'find'
	| 'replace'
	| 'go-to-line'
	| 'go-to-matching-bracket'
	| 'undo'
	| 'redo'
	| 'indent'
	| 'outdent'
	| 'toggle-comment'
	| 'fold'
	| 'unfold'
	| 'fold-all'
	| 'unfold-all'
	| 'duplicate-line-up'
	| 'duplicate-line-down'
	| 'move-line-up'
	| 'move-line-down'
	| 'delete-line'
	| 'select-next-occurrence';

export interface EditorStatusSnapshot {
	line: number;
	column: number;
	selectedCharacters: number;
	indentation: string;
	eol: 'LF' | 'CRLF' | 'CR';
	syntax: string;
}

const MIN_TOUCH_EDITOR_FONT_SIZE = 16;
const INDENTATION_SAMPLE_LENGTH = 16 * 1024;
const CONFIGURABLE_EDITOR_BINDINGS = new Set([
	'Alt-ArrowUp',
	'Shift-Alt-ArrowUp',
	'Alt-ArrowDown',
	'Shift-Alt-ArrowDown',
	'Mod-[',
	'Mod-]',
	'Shift-Mod-k',
	'Shift-Mod-\\',
	'Mod-/',
]);
const retainedDefaultKeymap = defaultKeymap.filter(
	(binding) => !binding.key || !CONFIGURABLE_EDITOR_BINDINGS.has(binding.key),
);
const retainedSearchKeymap = searchKeymap.filter(
	(binding) => binding.run !== openSearchPanel && binding.run !== gotoLine,
);
const NON_MUTATING_COMMANDS = new Set<FileEditorCommand>([
	'find',
	'go-to-line',
	'go-to-matching-bracket',
	'fold',
	'unfold',
	'fold-all',
	'unfold-all',
	'select-next-occurrence',
]);
const EDITOR_COMMANDS: Record<
	Exclude<FileEditorCommand, 'undo' | 'redo' | 'replace'>,
	(view: EditorView) => boolean
> = {
	find: openSearchPanel,
	'go-to-line': gotoLine,
	'go-to-matching-bracket': cursorMatchingBracket,
	indent: indentMore,
	outdent: indentLess,
	'toggle-comment': toggleComment,
	fold: foldCode,
	unfold: unfoldCode,
	'fold-all': foldAll,
	'unfold-all': unfoldAll,
	'duplicate-line-up': copyLineUp,
	'duplicate-line-down': copyLineDown,
	'move-line-up': moveLineUp,
	'move-line-down': moveLineDown,
	'delete-line': deleteLine,
	'select-next-occurrence': selectNextOccurrence,
};

export class CodeEditorController {
	readonly vim = new FileVimMode({
		getView: () => this.#view,
		undo: () => this.#runtime.undo(this.session.id),
		redo: () => this.#runtime.redo(this.session.id),
		save: () => this.onSave?.(),
	});
	#view: EditorView | null = null;
	#languageCompartment = new Compartment();
	#dynamicCompartment = new Compartment();
	#languageGeneration = 0;
	#rendererGeneration = 0;
	#unregisterRuntime: (() => void) | null = null;
	#statusVersion = $state(0);
	#indentationCache: { doc: Text; label: string } | null = null;
	readonly #runtime: FileDocumentRuntime;
	readonly #adapter: FileDocumentViewAdapter;
	#syntaxLabel = $state<string>(m.editor_status_plain_text());
	readonly #handleScroll = (): void => {
		const view = this.#view;
		if (view) this.#captureScroll(view);
	};

	constructor(
		readonly session: FileViewSession,
		private readonly settings: EditorPresentationSettings,
		private readonly onSave?: () => void,
	) {
		const existing = session.document.editorRuntime;
		this.#runtime =
			existing instanceof FileDocumentRuntime
				? existing
				: new FileDocumentRuntime(session.document, session.content);
		session.editorState = this.createState(
			this.#runtime.canonicalState.doc,
			session.editorState
				? clampSelection(session.editorState.selection, this.#runtime.canonicalState.doc.length)
				: undefined,
		);
		this.#adapter = {
			id: session.id,
			currentState: (): EditorState =>
				this.#view?.state ??
				this.session.editorState ??
				this.createState(this.#runtime.canonicalState.doc),
			applySourceTransactions: (transactions) => {
				const view = this.#view;
				if (!view) return;
				view.update(transactions);
				this.capture(view);
			},
			applyDocumentSpec: (spec) => {
				const view = this.#view;
				if (view) {
					view.update([view.state.update(spec)]);
					this.capture(view);
					return;
				}
				const current = this.session.editorState;
				if (current) {
					this.session.editorState = current.update(spec).state;
					this.#statusVersion += 1;
				}
			},
			replaceDocument: (spec) => {
				const view = this.#view;
				const left = view?.scrollDOM.scrollLeft ?? session.textScrollLeft;
				const top = view?.scrollDOM.scrollTop ?? session.textScrollTop;
				session.editorScrollSnapshot = null;
				this.#adapter.applyDocumentSpec(spec);
				session.textScrollLeft = left;
				session.textScrollTop = top;
				this.#restoreScrollAfterFrame(view, left, top);
			},
		};
		this.#unregisterRuntime = this.#runtime.register(this.#adapter);
	}

	get isAttached(): boolean {
		return this.#view !== null;
	}

	get scrollElement(): HTMLElement | null {
		return this.#view?.scrollDOM ?? null;
	}

	get status(): EditorStatusSnapshot {
		void this.#statusVersion;
		const current = this.#view?.state ?? this.session.editorState;
		const selection = current?.selection.main;
		const line = current && selection ? current.doc.lineAt(selection.head) : null;
		const selectedCharacters = current
			? current.selection.ranges.reduce((sum, range) => sum + range.to - range.from, 0)
			: 0;
		return {
			line: line?.number ?? 1,
			column: line && selection ? selection.head - line.from + 1 : 1,
			selectedCharacters,
			indentation: this.#indentationLabel(current?.doc ?? this.#runtime.canonicalState.doc),
			eol: lineSeparatorLabel(this.session.document.lineSeparator),
			syntax: this.#syntaxLabel,
		};
	}

	#indentationLabel(doc: Text): string {
		if (this.#indentationCache?.doc !== doc) {
			this.#indentationCache = { doc, label: indentationLabel(doc) };
		}
		return this.#indentationCache.label;
	}

	attach(parent: HTMLElement): number {
		if (this.#view) throw new Error('File editor renderer is already attached');
		const lease = ++this.#rendererGeneration;
		const storedState = this.session.editorState;
		const editorState = storedState
			? this.#stateWithCanonicalDocument(storedState)
			: this.createState(this.#runtime.canonicalState.doc);
		this.session.editorState = editorState;
		const scrollSnapshot = this.session.editorScrollSnapshot;
		const scrollLeft = this.session.textScrollLeft;
		const scrollTop = this.session.textScrollTop;
		const attachedView = new EditorView({
			state: editorState,
			parent,
			scrollTo: scrollSnapshot ?? undefined,
			dispatchTransactions: (transactions) => {
				if (this.#view !== attachedView || lease !== this.#rendererGeneration) return;
				if (
					attachedView.state.readOnly &&
					transactions.some((transaction) => transaction.docChanged)
				)
					return;
				this.#runtime.dispatchSource(this.#adapter, transactions);
			},
		});
		this.#view = attachedView;
		attachedView.scrollDOM.addEventListener('scroll', this.#handleScroll);
		this.reconfigure();
		void this.applyLanguage();
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
		if (view.scrollDOM.isConnected) this.#captureScroll(view);
		view.scrollDOM.removeEventListener('scroll', this.#handleScroll);
		this.session.editorState = view.state;
		view.destroy();
		this.#view = null;
	}

	reconfigure(): void {
		this.#view?.dispatch({
			effects: this.#dynamicCompartment.reconfigure(this.dynamicExtensions()),
		});
		this.vim.configure(Boolean(this.settings.vimMode));
	}

	focus(): void {
		this.#view?.focus();
	}

	currentContent(): string {
		return this.#runtime.content();
	}

	selectedText(): string {
		const current = this.#view?.state ?? this.session.editorState;
		if (!current) return '';
		return current.selection.ranges
			.map((range) => current.doc.sliceString(range.from, range.to))
			.filter(Boolean)
			.join('\n');
	}

	selectionLocation(): { line: number; column: number; endLine: number; endColumn: number } {
		const current = this.#view?.state ?? this.session.editorState;
		if (!current) return { line: 1, column: 1, endLine: 1, endColumn: 1 };
		const selection = current.selection.main;
		const start = current.doc.lineAt(selection.from);
		const end = current.doc.lineAt(selection.to);
		return {
			line: start.number,
			column: selection.from - start.from + 1,
			endLine: end.number,
			endColumn: selection.to - end.from + 1,
		};
	}

	run(command: FileEditorCommand): boolean {
		const view = this.#view;
		if (!view || !this.canRun(command)) return false;
		if (command === 'undo') return this.#runtime.undo(this.session.id);
		if (command === 'redo') return this.#runtime.redo(this.session.id);
		if (command === 'find' || command === 'replace' || command === 'go-to-line')
			this.vim.dismissDialog();
		if (command === 'replace') {
			return openFileReplacePanel(view);
		}
		return EDITOR_COMMANDS[command](view);
	}

	canRun(command: FileEditorCommand): boolean {
		return this.isAttached && (NON_MUTATING_COMMANDS.has(command) || !this.#readOnly);
	}

	get #readOnly(): boolean {
		return (
			this.session.readOnly || this.session.refreshing || this.session.document.mixedLineEndings
		);
	}

	closeSearch(): boolean {
		return this.#view ? closeSearchPanel(this.#view) : false;
	}

	closeDialog(): boolean {
		const dialog = this.#view ? getDialog(this.#view, 'cm-goto-line') : null;
		const close = dialog?.dom.querySelector<HTMLButtonElement>('button.cm-dialog-close');
		if (!close) return false;
		close.click();
		return true;
	}

	#restoreScrollAfterFrame(view: EditorView | null, left: number, top: number): void {
		requestAnimationFrame(() => {
			if (this.#view !== view || !view) return;
			view.scrollDOM.scrollLeft = left;
			view.scrollDOM.scrollTop = top;
			this.#captureScroll(view);
		});
	}

	applyRequestedLocation(): void {
		const view = this.#view;
		const lineNumber = this.session.requestedLine;
		if (!view || !lineNumber || lineNumber < 1) return;
		const position = documentPosition(
			view.state.doc,
			lineNumber,
			this.session.requestedColumn ?? 1,
		);
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
		this.#unregisterRuntime?.();
		this.#unregisterRuntime = null;
		this.#languageGeneration += 1;
	}

	private createState(content: Text, selection?: EditorSelection): EditorState {
		const editorState = EditorState.create({
			doc: content,
			selection,
			extensions: [
				this.vim.compartment.of([]),
				EditorState.allowMultipleSelections.of(true),
				highlightActiveLineGutter(),
				highlightSpecialChars(),
				drawSelection(),
				dropCursor(),
				EditorView.domEventHandlers({
					beforeinput: (event) => {
						const command = historyCommandForInputType(event.inputType);
						if (!command) return false;
						event.preventDefault();
						return command === 'undo'
							? this.#runtime.undo(this.session.id)
							: this.#runtime.redo(this.session.id);
					},
				}),
				EditorView.updateListener.of((update) => {
					if (update.docChanged || update.selectionSet) this.#statusVersion += 1;
				}),
				indentOnInput(),
				syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
				bracketMatching(),
				highlightActiveLine(),
				foldGutter(),
				fileSearchScope,
				search({ top: true, createPanel: createFileSearchPanel }),
				Prec.high(
					keymap.of([
						{ key: 'Mod-z', run: () => this.#runtime.undo(this.session.id), preventDefault: true },
						{
							key: 'Mod-y',
							mac: 'Mod-Shift-z',
							run: () => this.#runtime.redo(this.session.id),
							preventDefault: true,
						},
						{
							linux: 'Ctrl-Shift-z',
							run: () => this.#runtime.redo(this.session.id),
							preventDefault: true,
						},
					]),
				),
				keymap.of([
					...retainedDefaultKeymap,
					...retainedSearchKeymap,
					...foldKeymap,
					{ key: 'Tab', run: indentMore, shift: indentLess },
				]),
				this.#languageCompartment.of([]),
				this.#dynamicCompartment.of(this.dynamicExtensions()),
			],
		});
		return editorState;
	}

	private dynamicExtensions(): Extension[] {
		const configuredFontSize = this.settings.fontSize;
		const extensions: Extension[] = [
			EditorView.theme({
				'&': { isolation: 'isolate' },
				'.cm-content, .cm-gutters': {
					fontSize: `${Math.max(MIN_TOUCH_EDITOR_FONT_SIZE, configuredFontSize)}px`,
					fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
				},
				'.cm-panel input, .cm-panel select, .cm-panel button': {
					fontSize: `${MIN_TOUCH_EDITOR_FONT_SIZE}px`,
				},
				'.cm-panels': { backgroundColor: 'hsl(var(--card))', color: 'hsl(var(--foreground))' },
				'.cm-searchMatch': { backgroundColor: 'hsl(var(--accent) / 0.45)' },
				'.cm-searchMatch.cm-searchMatch-selected': { outline: '2px solid hsl(var(--ring))' },
				'@media (pointer: fine)': {
					'.cm-content, .cm-gutters': { fontSize: `${configuredFontSize}px` },
					'.cm-panel input, .cm-panel select, .cm-panel button': {
						fontSize: `${configuredFontSize}px`,
					},
				},
			}),
		];
		extensions.push(editorThemeExtension(this.settings.editorThemeId));
		if (this.settings.showLineNumbers) extensions.push(lineNumbers());
		if (this.settings.wordWrap) extensions.push(EditorView.lineWrapping);
		if (this.#readOnly) {
			extensions.push(EditorState.readOnly.of(true));
		}
		return extensions;
	}

	private capture(view: EditorView): void {
		this.session.editorState = view.state;
		this.#captureScroll(view);
	}

	#captureScroll(view: EditorView): void {
		this.session.editorScrollSnapshot = view.scrollSnapshot();
		this.session.textScrollLeft = view.scrollDOM.scrollLeft;
		this.session.textScrollTop = view.scrollDOM.scrollTop;
	}

	#stateWithCanonicalDocument(current: EditorState): EditorState {
		const canonical = this.#runtime.canonicalState.doc;
		if (current.doc.eq(canonical)) return current;
		return current.update({
			changes: { from: 0, to: current.doc.length, insert: canonical },
			selection: clampSelection(current.selection, canonical.length),
			filter: false,
		}).state;
	}

	private async applyLanguage(): Promise<void> {
		const generation = ++this.#languageGeneration;
		const loaded = await loadCodeMirrorLanguageForFile({ filePath: this.session.relativePath });
		if (generation !== this.#languageGeneration || !this.#view) return;
		this.#syntaxLabel = loaded?.key ?? syntaxLabel(this.session.relativePath);
		this.#view.dispatch({
			effects: this.#languageCompartment.reconfigure(loaded?.extensions ?? []),
		});
	}
}

function indentationLabel(doc: Text): string {
	for (const line of doc.iterRange(0, Math.min(doc.length, INDENTATION_SAMPLE_LENGTH))) {
		if (!/^\s+\S/.test(line)) continue;
		const match = line.match(/^[\t ]+/)?.[0] ?? '';
		if (match.includes('\t')) return m.editor_status_tabs();
		return m.editor_status_spaces({ count: Math.max(1, match.length) });
	}
	return m.editor_status_spaces({ count: 2 });
}

function lineSeparatorLabel(separator: '\n' | '\r' | '\r\n'): 'LF' | 'CR' | 'CRLF' {
	switch (separator) {
		case '\r\n':
			return 'CRLF';
		case '\r':
			return 'CR';
		case '\n':
			return 'LF';
	}
}

function syntaxLabel(path: string): string {
	return fileExtension(path).toUpperCase() || m.editor_status_plain_text();
}

function historyCommandForInputType(inputType: string): 'undo' | 'redo' | null {
	if (inputType === 'historyUndo') return 'undo';
	if (inputType === 'historyRedo') return 'redo';
	return null;
}
