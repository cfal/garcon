import * as m from '$lib/paraglide/messages.js';
import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';
import { mount, unmount } from 'svelte';
import X from '@lucide/svelte/icons/x';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import ArrowUp from '@lucide/svelte/icons/arrow-up';
import ArrowDown from '@lucide/svelte/icons/arrow-down';
import CaseSensitive from '@lucide/svelte/icons/case-sensitive';
import Regex from '@lucide/svelte/icons/regex';
import WholeWord from '@lucide/svelte/icons/whole-word';
import TextSelect from '@lucide/svelte/icons/text-select';
import ListChecks from '@lucide/svelte/icons/list-checks';
import Replace from '@lucide/svelte/icons/replace';
import ReplaceAll from '@lucide/svelte/icons/replace-all';
import {
	SearchQuery,
	closeSearchPanel,
	findNext,
	findPrevious,
	getSearchQuery,
	openSearchPanel,
	replaceAll,
	replaceNext,
	selectMatches,
	setSearchQuery,
} from '@codemirror/search';
import './file-search-panel.css';

const MATCH_COUNT_LIMIT = 1000;
const MATCH_COUNT_DOCUMENT_LIMIT = 1_000_000;
const COUNT_DEBOUNCE_MS = 100;

interface SearchScope {
	from: number;
	to: number;
}

const setFileSearchScope = StateEffect.define<SearchScope | null>();

export const fileSearchScope = StateField.define<SearchScope | null>({
	create: () => null,
	update(scope, transaction) {
		let next =
			scope && transaction.docChanged
				? {
						from: transaction.changes.mapPos(scope.from, -1),
						to: transaction.changes.mapPos(scope.to, 1),
					}
				: scope;
		for (const effect of transaction.effects) {
			if (effect.is(setFileSearchScope)) next = effect.value;
			if (effect.is(setSearchQuery) && effect.value.test !== withinFileSearchScope) next = null;
		}
		return next;
	},
});

function withinFileSearchScope(
	_match: string,
	state: EditorState,
	from: number,
	to: number,
): boolean {
	const scope = state.field(fileSearchScope, false);
	return Boolean(scope && from >= scope.from && to <= scope.to);
}

const searchPanels = new WeakMap<EditorView, FileSearchPanel>();

class FileSearchPanel implements Panel {
	readonly dom: HTMLElement;
	readonly top = true;
	readonly #searchField: HTMLInputElement;
	readonly #replaceField: HTMLInputElement;
	readonly #caseField: HTMLInputElement;
	readonly #regexpField: HTMLInputElement;
	readonly #wordField: HTMLInputElement;
	readonly #selectionField: HTMLInputElement;
	readonly #result: HTMLSpanElement;
	readonly #replaceRow: HTMLDivElement;
	readonly #disclosure: HTMLButtonElement;
	readonly #navigationButtons: HTMLButtonElement[];
	readonly #replaceButtons: HTMLButtonElement[];
	readonly #disposeIcons: (() => void)[] = [];
	#matches: SearchScope[] = [];
	#truncated = false;
	#countUnavailable = false;
	#countTimer: ReturnType<typeof setTimeout> | undefined;
	#query = new SearchQuery({ search: '' });

	constructor(readonly view: EditorView) {
		this.#searchField = this.#textField('search', m.editor_command_find());
		this.#searchField.setAttribute('main-field', 'true');
		this.#replaceField = this.#textField('replace', m.editor_command_replace());
		this.#caseField = this.#checkbox('case', m.editor_search_match_case());
		this.#regexpField = this.#checkbox('regexp', m.editor_search_regex());
		this.#wordField = this.#checkbox('word', m.editor_search_whole_word());
		this.#selectionField = this.#checkbox('selection', m.editor_search_selection_only());
		this.#selectionField.disabled = view.state.selection.main.empty;
		this.#result = document.createElement('span');
		this.#result.setAttribute('role', 'status');
		this.#result.setAttribute('aria-live', 'polite');
		this.#result.className = 'cm-search-results';
		this.dom = document.createElement('div');
		this.dom.className = 'cm-search cm-file-search';
		this.dom.setAttribute('role', 'search');
		this.dom.setAttribute('aria-label', m.editor_search_title());
		this.#disclosure = this.#button(m.editor_search_toggle_replace(), ChevronRight, () => {
			this.#expandReplace(Boolean(this.#replaceRow.hidden));
		});
		this.#disclosure.classList.add('cm-file-search-disclosure');
		this.#disclosure.setAttribute('aria-expanded', 'false');
		const searchControls = document.createElement('div');
		searchControls.className = 'cm-file-search-field';
		searchControls.append(
			this.#searchField,
			this.#label(this.#caseField, CaseSensitive),
			this.#label(this.#wordField, WholeWord),
			this.#label(this.#regexpField, Regex),
		);
		this.#navigationButtons = [
			this.#button(m.editor_search_previous(), ArrowUp, () => findPrevious(view)),
			this.#button(m.editor_search_next(), ArrowDown, () => findNext(view)),
			this.#button(m.editor_search_select_all(), ListChecks, () => selectMatches(view)),
		];
		const actions = document.createElement('div');
		actions.className = 'cm-file-search-actions';
		actions.append(
			this.#result,
			...this.#navigationButtons,
			this.#label(this.#selectionField, TextSelect),
		);
		const close = this.#button(m.editor_search_close(), X, () => closeSearchPanel(view));
		close.name = 'close';
		close.classList.add('cm-file-search-close');
		this.#replaceRow = document.createElement('div');
		this.#replaceRow.className = 'cm-file-search-replace';
		this.#replaceRow.hidden = true;
		this.#replaceButtons = [
			this.#button(m.editor_command_replace(), Replace, () => replaceNext(view)),
			this.#button(m.editor_search_replace_all(), ReplaceAll, () => replaceAll(view)),
		];
		this.#replaceRow.append(this.#replaceField, ...this.#replaceButtons);
		this.dom.append(this.#disclosure, searchControls, actions, close, this.#replaceRow);
		for (const field of [
			this.#searchField,
			this.#replaceField,
			this.#caseField,
			this.#regexpField,
			this.#wordField,
			this.#selectionField,
		]) {
			field.addEventListener(field.type === 'checkbox' ? 'change' : 'input', () => this.#commit());
		}
		this.dom.addEventListener('keydown', (event) => this.#keydown(event));
		this.#sync(getSearchQuery(view.state));
		this.#updateControls();
	}

	mount(): void {
		this.#searchField.focus();
		this.#searchField.select();
	}

	update(update: ViewUpdate): void {
		this.#selectionField.disabled =
			this.#searchScope() === null && this.view.state.selection.main.empty;
		const query = getSearchQuery(this.view.state);
		if (!query.eq(this.#query)) this.#sync(query);
		else if (update.docChanged || update.startState.field(fileSearchScope) !== this.#searchScope())
			this.#scheduleCount();
		else this.#announce();
		this.#updateControls();
	}

	destroy(): void {
		clearTimeout(this.#countTimer);
		searchPanels.delete(this.view);
		for (const dispose of this.#disposeIcons) dispose();
	}

	openReplace(): void {
		if (this.view.state.readOnly) return;
		this.#expandReplace(true);
		this.#replaceField.focus();
		this.#replaceField.select();
	}

	#expandReplace(expanded: boolean): void {
		this.#replaceRow.hidden = !expanded;
		this.#disclosure.setAttribute('aria-expanded', String(expanded));
		this.view.requestMeasure();
	}

	#commit(): void {
		const currentScope = this.#searchScope();
		const nextScope = this.#selectionField.checked
			? (currentScope ?? this.#selectedSearchRange())
			: null;
		const query = new SearchQuery({
			search: this.#searchField.value,
			replace: this.#replaceField.value,
			caseSensitive: this.#caseField.checked,
			regexp: this.#regexpField.checked,
			wholeWord: this.#wordField.checked,
			test: nextScope ? withinFileSearchScope : undefined,
		});
		const effects = [];
		if (nextScope !== currentScope) effects.push(setFileSearchScope.of(nextScope));
		if (!query.eq(this.#query)) {
			effects.push(setSearchQuery.of(query));
		}
		if (effects.length > 0) this.view.dispatch({ effects });
	}

	#searchScope(): SearchScope | null {
		return this.view.state.field(fileSearchScope, false) ?? null;
	}

	#selectedSearchRange(): { from: number; to: number } | null {
		const selection = this.view.state.selection.main;
		if (selection.empty) return null;
		return { from: selection.from, to: selection.to };
	}

	#sync(query: SearchQuery): void {
		this.#query = query;
		this.#searchField.value = query.search;
		this.#replaceField.value = query.replace;
		this.#caseField.checked = query.caseSensitive;
		this.#regexpField.checked = query.regexp;
		this.#wordField.checked = query.wholeWord;
		this.#selectionField.checked = query.test === withinFileSearchScope;
		this.#scheduleCount();
	}

	#scheduleCount(): void {
		clearTimeout(this.#countTimer);
		this.#countTimer = undefined;
		this.#matches = [];
		this.#truncated = false;
		this.#countUnavailable = this.view.state.doc.length > MATCH_COUNT_DOCUMENT_LIMIT;
		this.#result.textContent = '';
		this.#searchField.setAttribute(
			'aria-invalid',
			String(Boolean(this.#query.search && !this.#query.valid)),
		);
		// Clipping regex cursors changes boundary semantics and cannot bound a no-match scan.
		// Large documents retain full search commands without automatic whole-document counting.
		if (!this.#query.valid || this.#countUnavailable) {
			this.#announce();
			return;
		}
		// Counts stay off the typing path and selection-only updates reuse the bounded match cache.
		this.#countTimer = setTimeout(() => {
			this.#countTimer = undefined;
			const cursor = this.#query.getCursor(this.view.state);
			for (let match = cursor.next(); !match.done; match = cursor.next()) {
				if (this.#matches.length === MATCH_COUNT_LIMIT) {
					this.#truncated = true;
					break;
				}
				this.#matches.push({ from: match.value.from, to: match.value.to });
			}
			this.#announce();
			this.#updateControls();
		}, COUNT_DEBOUNCE_MS);
	}

	#announce(): void {
		if (this.#countTimer !== undefined) return;
		const count = this.#matches.length;
		const selection = this.view.state.selection.main;
		const index = this.#matches.findIndex(
			({ from, to }) => from === selection.from && to === selection.to,
		);
		const total = `${count}${this.#truncated ? '+' : ''}`;
		let message: string;
		if (!this.#query.search) {
			message = '';
		} else if (!this.#query.valid) {
			message = m.editor_search_invalid_regex();
		} else if (this.#countUnavailable) {
			message = m.editor_search_count_unavailable();
		} else if (count === 0) {
			message = m.editor_search_no_results();
		} else if (index >= 0) {
			message = m.editor_search_result_position({ current: index + 1, total });
		} else {
			message = m.editor_search_match_count({ count, total });
		}
		if (this.#result.textContent !== message) this.#result.textContent = message;
		this.#result.dataset.empty = String(
			Boolean(this.#query.search && !this.#countUnavailable && count === 0),
		);
	}

	#updateControls(): void {
		const noMatches =
			!this.#query.valid ||
			(!this.#countUnavailable && this.#countTimer === undefined && this.#matches.length === 0);
		for (const button of this.#navigationButtons) button.disabled = noMatches;
		this.#replaceField.disabled = this.view.state.readOnly;
		for (const control of this.#replaceButtons)
			control.disabled = this.view.state.readOnly || noMatches;
		this.#disclosure.disabled = this.view.state.readOnly;
	}

	#keydown(event: KeyboardEvent): void {
		if (event.isComposing) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeSearchPanel(this.view);
			return;
		}
		if (event.key !== 'Enter') return;
		if (event.target === this.#searchField) {
			event.preventDefault();
			const navigate = event.shiftKey ? findPrevious : findNext;
			navigate(this.view);
			return;
		}
		if (event.target === this.#replaceField) {
			event.preventDefault();
			replaceNext(this.view);
		}
	}

	#textField(name: string, label: string): HTMLInputElement {
		const input = document.createElement('input');
		input.name = name;
		input.type = 'text';
		input.placeholder = label;
		input.autocomplete = 'off';
		input.spellcheck = false;
		input.setAttribute('aria-label', label);
		input.className = 'cm-file-search-input';
		return input;
	}

	#checkbox(name: string, label: string): HTMLInputElement {
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.name = name;
		input.setAttribute('aria-label', label);
		return input;
	}

	#button(label: string, icon: typeof X, run: () => unknown): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'cm-file-search-button';
		button.title = label;
		this.#icon(icon, button);
		button.setAttribute('aria-label', label);
		button.onclick = () => run();
		return button;
	}

	#label(input: HTMLInputElement, icon: typeof X): HTMLLabelElement {
		const element = document.createElement('label');
		element.className = 'cm-file-search-toggle';
		element.title = input.getAttribute('aria-label') ?? '';
		element.append(input);
		this.#icon(icon, element);
		return element;
	}

	#icon(icon: typeof X, target: HTMLElement): void {
		const instance = mount(icon, { target, props: { size: 16, 'aria-hidden': 'true' } });
		this.#disposeIcons.push(() => {
			void unmount(instance);
		});
	}
}

export function createFileSearchPanel(view: EditorView): Panel {
	const panel = new FileSearchPanel(view);
	searchPanels.set(view, panel);
	return panel;
}

export function openFileReplacePanel(view: EditorView): boolean {
	openSearchPanel(view);
	searchPanels.get(view)?.openReplace();
	return true;
}
