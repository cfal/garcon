import { ApiError, ApiMutationOutcomeUnknownError } from '$lib/api/client.js';
import { browseDirectory, createDirectory } from '$lib/api/files.js';
import * as m from '$lib/paraglide/messages.js';
import { errorMessage } from '$lib/utils/error-message.js';
import {
	directoryNameProblem,
	type DirectoryEntry,
	type DirectoryNameProblem,
} from '$shared/file-contracts';
import {
	directoryBreadcrumbs,
	isWithinBasePath,
	normalizeDirectoryPath,
	parentDirectoryPath,
	splitTypedDirectoryPath,
	type DirectoryBreadcrumb,
} from './directory-location.js';

export interface DirectoryBrowserStateOptions {
	get executorId(): string;
	get executorContextKey(): string;
	/** Path held by the owning field; blank starts at the base. */
	get currentPath(): string;
	/** Confines browsing and creation to this subtree. */
	get basePath(): string;
	/** Keeps navigation local until confirm() instead of publishing each step. */
	get confirmsSelection(): boolean;
	onSelect(path: string): void;
	onClose(): void;
}

export type DirectoryListing =
	| { readonly status: 'loading' }
	| { readonly status: 'ready'; readonly entries: readonly DirectoryEntry[] }
	| { readonly status: 'error'; readonly message: string };

interface DirectoryTarget {
	readonly executorId: string;
	readonly directory: string;
}

// What the browser lists and how the looked-for name narrows it.
interface DirectoryView {
	readonly directory: string;
	readonly query: string;
	readonly matchesAnywhere: boolean;
}

const NAME_PROBLEM_MESSAGES: Record<Exclude<DirectoryNameProblem, 'empty'>, () => string> = {
	reserved: m.chat_directory_browser_name_reserved,
	'invalid-character': m.chat_directory_browser_name_invalid,
	'too-long': m.chat_directory_browser_name_too_long,
};

// Ancestors tried one listing at a time before a missing path opens the base.
const MAX_PARENT_FALLBACKS = 3;

function isFileError(error: unknown, errorCode: string): boolean {
	return error instanceof ApiError && error.errorCode === errorCode;
}

// A typed path lists its parent and narrows it by the name under edit. The
// base, a path ending in a separator, and a path the browser navigated to are
// known directories, so they list themselves.
function fieldView(typed: string, basePath: string, navigated: string | undefined): DirectoryView {
	const directory = normalizeDirectoryPath(typed);
	if (
		typed === navigated ||
		typed.endsWith('/') ||
		directory === normalizeDirectoryPath(basePath)
	) {
		return { directory, query: '', matchesAnywhere: false };
	}
	const split = splitTypedDirectoryPath(typed);
	return {
		directory: normalizeDirectoryPath(split.directory),
		// Kept exactly as typed, so names differing only in spacing stay distinct.
		query: split.partial,
		matchesAnywhere: false,
	};
}

/** Browses, selects, and creates directories for one path field on one executor. */
export class DirectoryBrowserState {
	readonly #options: DirectoryBrowserStateOptions;
	// `fallbacks` counts the steps this browser took away from a path that names
	// no directory; zero marks a directory the user reached from a listing.
	#navigation = $state.raw<(DirectoryTarget & { readonly fallbacks: number }) | null>(null);
	#filter = $state.raw<(DirectoryTarget & { readonly text: string }) | null>(null);
	#listed = $state.raw<{ readonly target: string; readonly listing: DirectoryListing } | null>(
		null,
	);
	#creation = $state<{
		readonly target: string;
		name: string;
		submitting: boolean;
		error: string | null;
	} | null>(null);
	#reloads = $state(0);

	// A host may still be resolving its base; nothing is listable before it arrives.
	readonly #hasBase = $derived.by(() => this.#options.basePath !== '');

	// Navigation made on another executor does not apply to this one.
	readonly #currentNavigation = $derived.by(() =>
		this.#navigation?.executorId === this.#options.executorId ? this.#navigation : null,
	);

	// The confirming browser owns its location and filter; the other follows the field.
	readonly #view = $derived.by((): DirectoryView => {
		const { basePath, currentPath, confirmsSelection } = this.#options;
		const typed =
			currentPath.trim() && isWithinBasePath(currentPath, basePath) ? currentPath : basePath;
		const navigated = this.#currentNavigation?.directory;
		if (!confirmsSelection) return fieldView(typed, basePath, navigated);
		const directory = navigated ?? normalizeDirectoryPath(typed);
		return { directory, query: this.#filterIn(directory).trim(), matchesAnywhere: true };
	});

	// Compared by value, so a typed name changing inside one directory does not
	// retarget the listing.
	readonly directory = $derived(this.#view.directory);
	readonly query = $derived(this.#view.query);

	// Identifies one listing: a directory as one serving instance of an executor sees it.
	readonly #target = $derived.by((): string => {
		const { executorId, executorContextKey } = this.#options;
		return JSON.stringify([executorId, executorContextKey, this.directory]);
	});

	// A result counts only for the target it was requested for, so entries of
	// one directory are never shown or selected as another's.
	readonly listing = $derived.by((): DirectoryListing => {
		const listed = this.#listed;
		return listed?.target === this.#target ? listed.listing : { status: 'loading' };
	});

	readonly entries = $derived.by((): readonly DirectoryEntry[] => {
		if (this.listing.status !== 'ready') return [];
		const query = this.query.toLowerCase();
		if (!query) return this.listing.entries;
		const { matchesAnywhere } = this.#view;
		return this.listing.entries.filter((entry) => {
			const name = entry.name.toLowerCase();
			return matchesAnywhere ? name.includes(query) : name.startsWith(query);
		});
	});

	readonly breadcrumbs = $derived.by((): DirectoryBreadcrumb[] =>
		directoryBreadcrumbs(this.directory, this.#options.basePath),
	);

	/** The creation form, which belongs to the directory it was opened in. */
	readonly creation = $derived.by(() => {
		const creation = this.#creation;
		return creation?.target === this.#target ? creation : null;
	});

	readonly #creationNameProblem = $derived(
		directoryNameProblem((this.creation?.name ?? '').trim()),
	);

	// Offers the name being looked for when no directory already has it.
	readonly suggestedName = $derived.by((): string | null => {
		if (this.listing.status !== 'ready' || this.creation) return null;
		const name = this.query.trim();
		if (directoryNameProblem(name) !== null) return null;
		return this.listing.entries.some((entry) => entry.name === name) ? null : name;
	});

	constructor(options: DirectoryBrowserStateOptions) {
		this.#options = options;
	}

	get parentPath(): string | null {
		return parentDirectoryPath(this.directory, this.#options.basePath);
	}

	/** Name filter typed into the browser, kept only for the directory it was typed in. */
	get filter(): string {
		return this.#filterIn(this.directory);
	}

	set filter(text: string) {
		this.#filter = { executorId: this.#options.executorId, directory: this.directory, text };
	}

	/**
	 * Whether the directory is known to exist: it was listed, or the user reached
	 * it from a listing on this executor and its own entries are still loading.
	 */
	get canConfirm(): boolean {
		const { status } = this.listing;
		if (status !== 'loading') return status === 'ready';
		const navigation = this.#currentNavigation;
		return (
			navigation !== null && navigation.fallbacks === 0 && navigation.directory === this.directory
		);
	}

	get canCreate(): boolean {
		return this.canConfirm;
	}

	get creationName(): string {
		return this.creation?.name ?? '';
	}

	set creationName(name: string) {
		const creation = this.creation;
		if (!creation || creation.submitting) return;
		creation.name = name;
		creation.error = null;
	}

	get creationError(): string | null {
		const creation = this.creation;
		if (!creation) return null;
		if (creation.error !== null) return creation.error;
		const problem = this.#creationNameProblem;
		return problem === null || problem === 'empty' ? null : NAME_PROBLEM_MESSAGES[problem]();
	}

	get canSubmitCreation(): boolean {
		const creation = this.creation;
		return creation !== null && !creation.submitting && this.#creationNameProblem === null;
	}

	/**
	 * Loads the listing for the current executor and directory. Runs inside an
	 * effect so it follows navigation, and returns the cancellation of its request.
	 */
	trackListing(): () => void {
		if (!this.#hasBase) return () => undefined;
		const { executorId } = this.#options;
		const directory = this.directory;
		const target = this.#target;
		void this.#reloads;
		const abort = new AbortController();
		void browseDirectory(directory, abort.signal, executorId).then(
			(entries) => {
				if (!abort.signal.aborted) this.#listed = { target, listing: { status: 'ready', entries } };
			},
			(error: unknown) => {
				if (abort.signal.aborted || this.#retreatToParent(error, executorId, directory)) return;
				const message = errorMessage(error, m.chat_directory_browser_load_failed());
				this.#listed = { target, listing: { status: 'error', message } };
			},
		);
		return () => abort.abort();
	}

	/** Reads the directory again. Listed entries stay visible meanwhile; a failure does not. */
	reload(): void {
		if (this.listing.status === 'error') this.#listed = null;
		this.#reloads += 1;
	}

	/** Moves to a directory inside the base; reports false for any other path. */
	navigate(path: string): boolean {
		const { basePath, executorId, confirmsSelection, onSelect } = this.#options;
		if (!isWithinBasePath(path, basePath)) return false;
		const directory = normalizeDirectoryPath(path);
		this.#navigation = { executorId, directory, fallbacks: 0 };
		this.#filter = null;
		this.#creation = null;
		if (!confirmsSelection) onSelect(directory);
		return true;
	}

	confirm(): void {
		if (!this.canConfirm) return;
		this.#options.onSelect(this.directory);
		this.#options.onClose();
	}

	startCreation(name = ''): void {
		if (!this.canCreate) return;
		this.#creation = { target: this.#target, name, submitting: false, error: null };
	}

	cancelCreation(): void {
		this.#creation = null;
	}

	/** Ends the browser's life; a creation still in flight must not select or move it. */
	dispose(): void {
		this.#creation = null;
	}

	/** Resolves true once the browser has moved into the created directory. */
	async submitCreation(): Promise<boolean> {
		const creation = this.creation;
		if (!creation || !this.canSubmitCreation) return false;
		// Surrounding whitespace in a typed name is almost always accidental.
		const name = creation.name.trim();
		const request = { executorId: this.#options.executorId, parentPath: this.directory, name };
		creation.submitting = true;
		creation.error = null;
		const outcome = await createDirectory(request).then(
			(created) => ({ created }),
			(error: unknown) => ({ error }),
		);
		// A form the user cancelled or replaced, or a closed browser, ignores the
		// result. The directory may exist all the same, so the list is read again.
		if (this.#creation !== creation) {
			this.#reloads += 1;
			return false;
		}
		// The field or executor moved the browser elsewhere while the request ran.
		if (creation.target !== this.#target) {
			this.#creation = null;
			return false;
		}
		if ('created' in outcome) {
			if (this.navigate(outcome.created.path)) return true;
			// The executor reported a path this browser cannot address, so the
			// directory is shown where it was created instead.
			this.#creation = null;
			this.#reloads += 1;
			return false;
		}
		const { error } = outcome;
		const exists = isFileError(error, 'FILE_ALREADY_EXISTS');
		const unconfirmed = error instanceof ApiMutationOutcomeUnknownError;
		creation.submitting = false;
		if (exists) creation.error = m.chat_directory_browser_name_exists({ name });
		else if (unconfirmed) creation.error = m.chat_directory_browser_create_unconfirmed();
		else creation.error = errorMessage(error, m.chat_directory_browser_create_failed());
		// Only these failures can leave a directory the list does not show yet.
		if (exists || unconfirmed) this.#reloads += 1;
		return false;
	}

	#filterIn(directory: string): string {
		const filter = this.#filter;
		const applies =
			filter?.executorId === this.#options.executorId && filter.directory === directory;
		return applies ? filter.text : '';
	}

	// The confirming browser opens on the field's path as a directory. A path that
	// names none opens a nearby ancestor instead. A missing name becomes the
	// filter, so the list offers to create it; a file's name does not. Each step
	// costs one listing, so a path missing more than a few levels opens the base.
	#retreatToParent(error: unknown, executorId: string, directory: string): boolean {
		const navigation = this.#currentNavigation;
		if (!this.#options.confirmsSelection || navigation?.fallbacks === 0) return false;
		const missing = isFileError(error, 'FILE_NOT_FOUND');
		if (!missing && !isFileError(error, 'FILE_DIRECTORY_REQUIRED')) return false;
		const parent = parentDirectoryPath(directory, this.#options.basePath);
		if (parent === null) return false;
		const fallbacks = (navigation?.fallbacks ?? 0) + 1;
		if (fallbacks > MAX_PARENT_FALLBACKS) {
			const base = normalizeDirectoryPath(this.#options.basePath);
			this.#navigation = { executorId, directory: base, fallbacks };
			this.#filter = null;
			return true;
		}
		this.#navigation = { executorId, directory: parent, fallbacks };
		this.#filter = missing
			? { executorId, directory: parent, text: splitTypedDirectoryPath(directory).partial }
			: null;
		return true;
	}
}
