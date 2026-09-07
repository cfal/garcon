import { history, historyKeymap } from '@codemirror/commands';
import {
	Annotation,
	Compartment,
	EditorSelection,
	EditorState,
	Prec,
	Transaction,
} from '@codemirror/state';
import {
	drawSelection,
	dropCursor,
	EditorView,
	highlightSpecialChars,
	keymap,
	type ViewUpdate,
} from '@codemirror/view';
import {
	PROMPT_EDITOR_KEYMAP,
	PROMPT_EDITOR_STANDARD_KEYMAP,
	ownsPromptEditorShortcut,
} from './prompt-editor-keymap.js';
import {
	clampPromptEditorSelection,
	type PromptEditorSelection,
} from './prompt-editor-selection.js';
import {
	registerNativeWorkspaceScrollRegion,
	scrollWorkspaceRegion,
} from '$lib/workspace/workspace-scroll-region.js';
import type { GlobalShortcutId } from '$lib/workspace/global-shortcuts.js';
import type {
	WorkspaceLocalShortcutOwner,
	WorkspaceShortcutDispatcher,
} from '$lib/workspace/workspace-shortcuts.js';

const externalDocumentSync = Annotation.define<boolean>();

export interface PromptEditorControllerOptions {
	initialText: string;
	initialSelection: PromptEditorSelection;
	ariaLabel: string;
	readOnly?: boolean;
	workspaceShortcuts: Pick<
		WorkspaceShortcutDispatcher,
		'matchesGlobalShortcut' | 'registerLocalShortcutOwner'
	>;
	onTextChange: (text: string) => void;
	onSelectionChange: (selection: PromptEditorSelection) => void;
}

export class PromptEditorController {
	readonly #view: EditorView;
	readonly #unregisterLocalOwner: () => void;
	readonly #unregisterScrollRegion: () => void;
	readonly #readOnlyCompartment = new Compartment();
	#selectionNotificationQueued = false;
	#destroyed = false;
	#readOnly: boolean;

	constructor(
		parent: HTMLElement,
		private readonly options: PromptEditorControllerOptions,
	) {
		this.#readOnly = options.readOnly ?? false;
		const initialSelection = clampPromptEditorSelection(
			options.initialSelection,
			options.initialText.length,
		);
		const editorState = EditorState.create({
			doc: options.initialText,
			selection: EditorSelection.single(initialSelection.anchor, initialSelection.head),
			extensions: [
				this.#readOnlyCompartment.of([
					EditorState.readOnly.of(this.#readOnly),
					EditorView.editable.of(!this.#readOnly),
				]),
				highlightSpecialChars(),
				history(),
				drawSelection(),
				dropCursor(),
				EditorView.lineWrapping,
				Prec.high(
					EditorView.domEventHandlers({
						keydown: (event, view) => this.#handleScrollShortcut(event, view),
					}),
				),
				Prec.high(keymap.of([...PROMPT_EDITOR_KEYMAP])),
				keymap.of([...PROMPT_EDITOR_STANDARD_KEYMAP, ...historyKeymap]),
				EditorView.contentAttributes.of({
					'aria-label': options.ariaLabel,
					'aria-multiline': 'true',
					'aria-readonly': String(this.#readOnly),
				}),
				EditorView.updateListener.of((update) => this.#handleUpdate(update)),
				EditorView.theme({
					'&': {
						height: '100%',
						backgroundColor: 'transparent',
						color: 'hsl(var(--foreground))',
					},
					'&.cm-focused': { outline: 'none' },
					'.cm-scroller': {
						fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
						fontSize: '16px',
						lineHeight: '1.55',
						overflow: 'auto',
					},
					'.cm-content': {
						caretColor: 'hsl(var(--foreground))',
						minHeight: '100%',
						padding: '16px 18px',
					},
					'.cm-cursor, .cm-dropCursor': {
						borderLeftColor: 'hsl(var(--foreground))',
					},
					'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
						backgroundColor: 'hsl(var(--accent))',
					},
					'@media (pointer: fine)': {
						'.cm-scroller': { fontSize: '14px' },
					},
				}),
			],
		});

		this.#view = new EditorView({ state: editorState, parent });
		const localOwner: WorkspaceLocalShortcutOwner = (event) =>
			ownsPromptEditorShortcut(event, this.#view.composing);
		this.#unregisterLocalOwner = options.workspaceShortcuts.registerLocalShortcutOwner(
			this.#view.dom,
			localOwner,
		);
		this.#unregisterScrollRegion = registerNativeWorkspaceScrollRegion(
			this.#view.scrollDOM,
			'primary',
		);
		this.#emitSelection();
	}

	focus(): void {
		this.#view.focus();
	}

	syncText(text: string, requestedSelection: PromptEditorSelection = this.selection): void {
		if (text === this.#view.state.doc.toString()) return;
		const selection = clampPromptEditorSelection(requestedSelection, text.length);
		this.#view.dispatch({
			changes: { from: 0, to: this.#view.state.doc.length, insert: text },
			selection: EditorSelection.single(selection.anchor, selection.head),
			annotations: [externalDocumentSync.of(true), Transaction.addToHistory.of(false)],
		});
	}

	setReadOnly(readOnly: boolean): void {
		if (readOnly === this.#readOnly) return;
		this.#readOnly = readOnly;
		this.#view.dispatch({
			effects: this.#readOnlyCompartment.reconfigure([
				EditorState.readOnly.of(readOnly),
				EditorView.editable.of(!readOnly),
			]),
		});
		this.#view.contentDOM.setAttribute('aria-readonly', String(readOnly));
	}

	get selection(): PromptEditorSelection {
		const selection = this.#view.state.selection.main;
		return { anchor: selection.anchor, head: selection.head };
	}

	destroy(): void {
		this.#destroyed = true;
		this.#unregisterLocalOwner();
		this.#unregisterScrollRegion();
		this.#view.destroy();
	}

	#handleUpdate(update: ViewUpdate): void {
		const external = update.transactions.some((transaction) =>
			transaction.annotation(externalDocumentSync),
		);
		if (update.docChanged && !external) {
			this.options.onTextChange(update.state.doc.toString());
		}
		if (update.docChanged || update.selectionSet) this.#emitSelection();
	}

	#handleScrollShortcut(event: KeyboardEvent, view: EditorView): boolean {
		if (event.isComposing || view.composing) return false;
		const direction = this.#scrollDirection(event);
		if (!direction) return false;
		event.preventDefault();
		scrollWorkspaceRegion(view.scrollDOM, direction);
		return true;
	}

	#scrollDirection(event: KeyboardEvent): 'earlier' | 'later' | null {
		const matches = (id: GlobalShortcutId) =>
			this.options.workspaceShortcuts.matchesGlobalShortcut(id, event);
		if (matches('scroll-half-page-up')) return 'earlier';
		if (matches('scroll-half-page-down')) return 'later';
		return null;
	}

	#emitSelection(): void {
		if (this.#selectionNotificationQueued) return;
		this.#selectionNotificationQueued = true;
		queueMicrotask(() => {
			this.#selectionNotificationQueued = false;
			if (!this.#destroyed) this.options.onSelectionChange(this.selection);
		});
	}
}
