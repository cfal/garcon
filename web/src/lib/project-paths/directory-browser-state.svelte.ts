import { ApiError, ApiMutationOutcomeUnknownError } from '$lib/api/client.js';
import { browseDirectory, createDirectory, type DirectoryEntry } from '$lib/api/files.js';
import * as m from '$lib/paraglide/messages.js';
import { directoryNameProblem, type DirectoryNameProblem } from '$shared/file-contracts';
import {
	directoryBreadcrumbs,
	isWithinBasePath,
	normalizeDirectoryPath,
	parentDirectoryPath,
	splitTypedDirectoryPath,
	type DirectoryBreadcrumb,
	type TypedDirectoryPath,
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

export interface DirectoryCreation {
	readonly name: string;
	readonly submitting: boolean;
	readonly error: string | null;
}

interface DirectoryTarget {
	readonly executorId: string;
	readonly directory: string;
}

const NAME_PROBLEM_MESSAGES: Record<Exclude<DirectoryNameProblem, 'empty'>, () => string> = {
	reserved: m.chat_directory_browser_name_reserved,
	'invalid-character': m.chat_directory_browser_name_invalid,
	'too-long': m.chat_directory_browser_name_too_long,
};

function nameProblemMessage(name: string): string | null {
	const problem = directoryNameProblem(name);
	return problem === null || problem === 'empty' ? null : NAME_PROBLEM_MESSAGES[problem]();
}

function creationFailureMessage(error: unknown, name: string): string {
	if (error instanceof ApiMutationOutcomeUnknownError) {
		return m.chat_directory_browser_create_unconfirmed();
	}
	if (isFileError(error, 'FILE_ALREADY_EXISTS')) {
		return m.chat_directory_browser_name_exists({ name });
	}
	return (error instanceof Error && error.message) || m.chat_directory_browser_create_failed();
}

function isFileError(error: unknown, errorCode: string): boolean {
	return error instanceof ApiError && error.errorCode === errorCode;
}

/** Browses, selects, and creates directories for one path field on one executor. */
export class DirectoryBrowserState {
	readonly #options: DirectoryBrowserStateOptions;
	// `listed` marks a directory the user reached from a listing, as opposed to
	// one this browser fell back to.
	#navigation = $state.raw<(DirectoryTarget & { readonly listed: boolean }) | null>(null);
	#filter = $state.raw<(DirectoryTarget & { readonly text: string }) | null>(null);
	#listed = $state.raw<{ readonly target: string; readonly listing: DirectoryListing } | null>(
		null,
	);
	#creation = $state<{ name: string; submitting: boolean; error: string | null } | null>(null);
	#reloads = $state(0);
	#creationAttempt = 0;
	#navigated = false;
	#disposed = false;

	// A typed path lists its parent and filters by the name under edit. A path
	// this browser navigated to is a known directory, so it lists that directory.
	readonly #location = $derived.by((): TypedDirectoryPath => {
		const { basePath, currentPath, executorId, confirmsSelection } = this.#options;
		const typed =
			currentPath.trim() && isWithinBasePath(currentPath, basePath) ? currentPath : basePath;
		const navigation = this.#navigation?.executorId === executorId ? this.#navigation : null;
		if (navigation && (confirmsSelection || navigation.directory === typed)) {
			return { directory: navigation.directory, partial: '' };
		}
		const directory = normalizeDirectoryPath(typed);
		if (
			confirmsSelection ||
			typed.endsWith('/') ||
			directory === normalizeDirectoryPath(basePath)
		) {
			return { directory, partial: '' };
		}
		const split = splitTypedDirectoryPath(typed);
		return { directory: normalizeDirectoryPath(split.directory), partial: split.partial };
	});

	// Compared by value, so a typed name changing inside one directory does not
	// retarget the listing.
	readonly #directory = $derived.by((): string => this.#location.directory);

	// Identifies one listing: a directory as one serving instance of an executor sees it.
	readonly #target = $derived.by((): string => {
		const { executorId, executorContextKey } = this.#options;
		return JSON.stringify([executorId, executorContextKey, this.#directory]);
	});

	// A result counts only for the target it was requested for, so entries of
	// one directory are never shown or selected as another's.
	readonly listing = $derived.by((): DirectoryListing => {
		const listed = this.#listed;
		return listed?.target === this.#target ? listed.listing : { status: 'loading' };
	});

	// The confirming browser filters by its own input; the other follows the
	// typed name exactly, so names differing only in spacing stay distinct.
	readonly #query = $derived.by((): string =>
		this.#options.confirmsSelection ? this.filter.trim() : this.#location.partial,
	);

	readonly entries = $derived.by((): readonly DirectoryEntry[] => {
		if (this.listing.status !== 'ready') return [];
		const query = this.#query.toLowerCase();
		if (!query) return this.listing.entries;
		const matchesAnywhere = this.#options.confirmsSelection;
		return this.listing.entries.filter((entry) => {
			const name = entry.name.toLowerCase();
			return matchesAnywhere ? name.includes(query) : name.startsWith(query);
		});
	});

	readonly breadcrumbs = $derived.by((): DirectoryBreadcrumb[] =>
		directoryBreadcrumbs(this.directory, this.#options.basePath),
	);

	// Offers the name being looked for when no directory already has it.
	readonly suggestedName = $derived.by((): string | null => {
		if (this.listing.status !== 'ready' || this.#creation) return null;
		const name = this.#query.trim();
		if (directoryNameProblem(name) !== null) return null;
		return this.listing.entries.some((entry) => entry.name === name) ? null : name;
	});

	constructor(options: DirectoryBrowserStateOptions) {
		this.#options = options;
	}

	get directory(): string {
		return this.#directory;
	}

	get parentPath(): string | null {
		return parentDirectoryPath(this.directory, this.#options.basePath);
	}

	/** Name filter typed into the browser, kept only for the directory it was typed in. */
	get filter(): string {
		const filter = this.#filter;
		if (filter?.executorId !== this.#options.executorId) return '';
		return filter.directory === this.directory ? filter.text : '';
	}

	set filter(text: string) {
		this.#filter = { executorId: this.#options.executorId, directory: this.directory, text };
	}

	get query(): string {
		return this.#query;
	}

	/**
	 * Whether the directory is known to exist: it was listed, or the user reached
	 * it from a listing on this executor and its own entries are still loading.
	 */
	get canConfirm(): boolean {
		const { status } = this.listing;
		if (status !== 'loading') return status === 'ready';
		const navigation = this.#navigation;
		return (
			navigation !== null &&
			navigation.listed &&
			navigation.executorId === this.#options.executorId &&
			navigation.directory === this.#directory
		);
	}

	get canCreate(): boolean {
		return this.canConfirm;
	}

	get creation(): DirectoryCreation | null {
		return this.#creation;
	}

	get creationName(): string {
		return this.#creation?.name ?? '';
	}

	set creationName(name: string) {
		if (!this.#creation || this.#creation.submitting) return;
		this.#creation.name = name;
		this.#creation.error = null;
	}

	get creationError(): string | null {
		if (!this.#creation) return null;
		return this.#creation.error ?? nameProblemMessage(this.#creation.name.trim());
	}

	get canSubmitCreation(): boolean {
		return (
			this.#creation !== null &&
			!this.#creation.submitting &&
			directoryNameProblem(this.#creation.name.trim()) === null
		);
	}

	/**
	 * Loads the listing for the current executor and directory. Runs inside an
	 * effect so it follows navigation, and returns the cancellation of its request.
	 */
	trackListing(): () => void {
		const { executorId } = this.#options;
		const directory = this.#directory;
		const target = this.#target;
		void this.#reloads;
		const abort = new AbortController();
		void browseDirectory(directory, abort.signal, executorId).then(
			(entries) => {
				if (!abort.signal.aborted) this.#listed = { target, listing: { status: 'ready', entries } };
			},
			(error: unknown) => {
				if (abort.signal.aborted || this.#retreatToParent(error, executorId, directory)) return;
				const message =
					(error instanceof Error && error.message) || m.chat_directory_browser_load_failed();
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
		this.#navigated = true;
		this.#navigation = { executorId, directory, listed: true };
		this.#filter = null;
		this.#creationAttempt += 1;
		this.#creation = null;
		if (!confirmsSelection) onSelect(directory);
		return true;
	}

	/** Ends the browser's life; work still in flight must not select or move it. */
	dispose(): void {
		this.#disposed = true;
	}

	confirm(): void {
		if (!this.canConfirm) return;
		this.#options.onSelect(this.directory);
		this.#options.onClose();
	}

	startCreation(name = ''): void {
		if (!this.canCreate) return;
		this.#creationAttempt += 1;
		this.#creation = { name, submitting: false, error: null };
	}

	cancelCreation(): void {
		this.#creationAttempt += 1;
		this.#creation = null;
	}

	/** Resolves true once the browser has moved into the created directory. */
	async submitCreation(): Promise<boolean> {
		const creation = this.#creation;
		if (!creation || !this.canSubmitCreation) return false;
		const { executorId } = this.#options;
		const parentPath = this.directory;
		// Surrounding whitespace in a typed name is almost always accidental.
		const name = creation.name.trim();
		const target = this.#target;
		const attempt = this.#creationAttempt;
		creation.submitting = true;
		creation.error = null;
		try {
			const created = await createDirectory({ executorId, parentPath, name });
			if (this.#disposed || this.#settleStaleCreation(target, attempt)) return false;
			if (this.navigate(created.path)) return true;
			// The executor reported a path this browser cannot address, so the
			// directory is shown where it was created instead.
			this.#creation = null;
			this.reload();
			return false;
		} catch (error) {
			if (this.#disposed) return false;
			if (this.#settleStaleCreation(target, attempt) || !this.#creation) return false;
			// The directory may exist after a failure, so the list is read again.
			this.reload();
			this.#creation.submitting = false;
			this.#creation.error = creationFailureMessage(error, name);
			return false;
		}
	}

	// A result for a directory no longer on screen, or for a form the user left,
	// must not move the browser. The form is cleared unless a newer one replaced it.
	#settleStaleCreation(target: string, attempt: number): boolean {
		const sameTarget = target === this.#target;
		const sameAttempt = attempt === this.#creationAttempt;
		if (sameTarget && sameAttempt) return false;
		if (sameAttempt) this.#creation = null;
		if (sameTarget) this.reload();
		return true;
	}

	// The confirming browser opens on the field's path as a directory. A path that
	// names none opens its nearest listable ancestor instead. A missing name
	// becomes the filter, so the list offers to create it; a file's name does not.
	#retreatToParent(error: unknown, executorId: string, directory: string): boolean {
		if (!this.#options.confirmsSelection || this.#navigated) return false;
		const missing = isFileError(error, 'FILE_NOT_FOUND');
		if (!missing && !isFileError(error, 'FILE_DIRECTORY_REQUIRED')) return false;
		const parent = parentDirectoryPath(directory, this.#options.basePath);
		if (parent === null) return false;
		this.#navigation = { executorId, directory: parent, listed: false };
		this.#filter = missing
			? { executorId, directory: parent, text: splitTypedDirectoryPath(directory).partial }
			: null;
		return true;
	}
}
