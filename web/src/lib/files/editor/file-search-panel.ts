import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import type { EditorView, Panel } from '@codemirror/view';
import {
	SearchQuery,
	closeSearchPanel,
	findNext,
	findPrevious,
	getSearchQuery,
	replaceAll,
	replaceNext,
	selectMatches,
	setSearchQuery,
} from '@codemirror/search';

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
	#query = new SearchQuery({ search: '' });

	constructor(readonly view: EditorView) {
		this.#searchField = this.#textField('search', 'Find');
		this.#searchField.setAttribute('main-field', 'true');
		this.#replaceField = this.#textField('replace', 'Replace');
		this.#caseField = this.#checkbox('case', 'Match case');
		this.#regexpField = this.#checkbox('regexp', 'Regular expression');
		this.#wordField = this.#checkbox('word', 'Whole word');
		this.#selectionField = this.#checkbox('selection', 'Selection only');
		this.#selectionField.disabled = view.state.selection.main.empty;
		this.#result = document.createElement('span');
		this.#result.setAttribute('role', 'status');
		this.#result.setAttribute('aria-live', 'polite');
		this.#result.className = 'cm-search-results';
		this.dom = document.createElement('div');
		this.dom.className = 'cm-search';
		this.dom.append(
			this.#searchField,
			this.#button('Previous', () => findPrevious(view)),
			this.#button('Next', () => findNext(view)),
			this.#button('All', () => selectMatches(view)),
			this.#label(this.#caseField, 'Match case'),
			this.#label(this.#regexpField, 'Regex'),
			this.#label(this.#wordField, 'Whole word'),
			this.#label(this.#selectionField, 'Selection only'),
			this.#result,
		);
		if (!view.state.readOnly) {
			this.dom.append(
				document.createElement('br'),
				this.#replaceField,
				this.#button('Replace', () => replaceNext(view)),
				this.#button('Replace all', () => replaceAll(view)),
			);
		}
		const close = this.#button('Close', () => closeSearchPanel(view));
		close.name = 'close';
		this.dom.append(close);
		for (const field of [
			this.#searchField,
			this.#replaceField,
			this.#caseField,
			this.#regexpField,
			this.#wordField,
			this.#selectionField,
		]) {
			field.addEventListener('input', () => this.#commit());
			field.addEventListener('change', () => this.#commit());
		}
		this.dom.addEventListener('keydown', (event) => this.#keydown(event));
		this.#sync(getSearchQuery(view.state));
	}

	mount(): void {
		this.#searchField.select();
	}

	update(): void {
		this.#selectionField.disabled =
			this.#searchScope() === null && this.view.state.selection.main.empty;
		const query = getSearchQuery(this.view.state);
		if (!query.eq(this.#query)) this.#sync(query);
		else this.#announce();
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
			this.#query = query;
			effects.push(setSearchQuery.of(query));
		}
		if (effects.length > 0) this.view.dispatch({ effects });
		this.#announce();
	}

	#searchScope(): SearchScope | null {
		return this.view.state.field(fileSearchScope, false) ?? null;
	}

	#selectedSearchRange(): { from: number; to: number } | null {
		const selection = this.view.state.selection.main;
		if (!this.#selectionField.checked || selection.empty) return null;
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
		this.#announce();
	}

	#announce(): void {
		if (!this.#query.valid || !this.#query.search) {
			this.#result.textContent = '';
			return;
		}
		let count = 0;
		const cursor = this.#query.getCursor(this.view.state);
		while (!cursor.next().done) count += 1;
		if (count === 0) {
			this.#result.textContent = 'No results';
			return;
		}
		this.#result.textContent = `${count} ${count === 1 ? 'result' : 'results'}`;
	}

	#keydown(event: KeyboardEvent): void {
		if (event.isComposing) return;
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
		input.setAttribute('aria-label', label);
		input.className = 'cm-textfield';
		return input;
	}

	#checkbox(name: string, label: string): HTMLInputElement {
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.name = name;
		input.setAttribute('aria-label', label);
		return input;
	}

	#button(label: string, run: () => boolean): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'cm-button';
		button.textContent = label;
		button.setAttribute('aria-label', label);
		button.onclick = () => run();
		return button;
	}

	#label(input: HTMLInputElement, label: string): HTMLLabelElement {
		const element = document.createElement('label');
		element.append(input, label);
		return element;
	}
}

export function createFileSearchPanel(view: EditorView): Panel {
	return new FileSearchPanel(view);
}
