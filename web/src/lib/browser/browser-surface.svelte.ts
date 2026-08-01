// Rune-backed state for the Browser surface: committed URL, address input,
// host-side navigation stacks, and iframe remount generation.

import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	removeLocalStorageItem,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import {
	isEmbedVerdict,
	MAX_EMBED_CHECK_URL_LENGTH,
	type EmbedVerdict,
} from '$shared/browser-embed';
import { checkEmbeddable } from '$lib/api/browser.js';
import { normalizeBrowserUrl, type BrowserUrlRejection } from './browser-url.js';

// Sandbox tokens are the security contract of the surface; change only with a
// BROWSER_SURFACE_DESIGN.md update. Deliberately absent: allow-top-navigation*
// (the frame must never navigate Garcon away), allow-modals, and
// allow-popups-to-escape-sandbox — an escaped popup is an unsandboxed
// top-level context that could navigate its opener's top via
// `opener.top.location`, which would defeat the no-top-navigation rule.
// Popups still open; they simply inherit these restrictions.
export const BROWSER_IFRAME_SANDBOX =
	'allow-scripts allow-forms allow-same-origin allow-downloads allow-popups';

// Advisory framing probe; null verdicts are ignored. Injectable so unit
// tests run without the HTTP client; pass null to disable probing.
export type EmbedProbe = (url: string) => Promise<EmbedVerdict | null>;

const defaultEmbedProbe: EmbedProbe = async (url) => {
	try {
		const response = await checkEmbeddable(url);
		return isEmbedVerdict(response.verdict) ? response.verdict : null;
	} catch {
		return null;
	}
};

interface BrowserSurfaceControllerOptions {
	appOrigin?: string;
	embedProbe?: EmbedProbe | null;
}

// Back/forward stacks are session-only by design; only the committed URL
// persists across reloads.
const MAX_STACK = 50;
const MAX_PERSISTED_URL_LENGTH = 8192;

function resolveAppOrigin(): string {
	return typeof window === 'undefined' ? '' : window.location.origin;
}

export class BrowserSurfaceController implements PortableSingletonController {
	/** Last URL committed to the iframe; null shows the empty state. */
	committedUrl = $state<string | null>(null);
	/** Address bar text; tracks committedUrl until the user edits it. */
	inputValue = $state('');
	/**
	 * Incremented for every host navigation; the template keys the iframe on it
	 * so committing a URL never appends to the joint session history.
	 */
	frameGeneration = $state(0);
	rejection = $state<BrowserUrlRejection | null>(null);
	/** Advisory framing verdict for the committed URL; null while unknown. */
	embedVerdict = $state<EmbedVerdict | null>(null);
	canGoBack = $state(false);
	canGoForward = $state(false);

	#back: string[] = [];
	#forward: string[] = [];
	#navigationSequence = 0;
	readonly #appOrigin: string;
	readonly #embedProbe: EmbedProbe | null;

	constructor(options: BrowserSurfaceControllerOptions = {}) {
		this.#appOrigin = options.appOrigin ?? resolveAppOrigin();
		this.#embedProbe = options.embedProbe === undefined ? defaultEmbedProbe : options.embedProbe;
		const restored = this.#readPersisted();
		if (restored) {
			this.committedUrl = restored;
			this.inputValue = restored;
			// A restored URL is displayed without going through #commit, so it
			// needs its own probe or the refusal banner could never appear after
			// a reload or a close/reopen.
			this.#probeEmbeddability(restored);
		}
	}

	get appOrigin(): string {
		return this.#appOrigin;
	}

	/** Navigating to the committed URL again reloads it without a stack push. */
	navigate(rawInput: string): boolean {
		const result = normalizeBrowserUrl(rawInput, this.#appOrigin);
		if (!result.ok) {
			this.rejection = result.reason;
			return false;
		}
		if (this.committedUrl && this.committedUrl !== result.url) {
			this.#back.push(this.committedUrl);
			if (this.#back.length > MAX_STACK) this.#back.shift();
			this.#forward = [];
		}
		this.#commit(result.url);
		return true;
	}

	reload(): void {
		if (this.committedUrl === null) return;
		this.rejection = null;
		this.frameGeneration += 1;
	}

	goBack(): void {
		const previous = this.#back.pop();
		if (previous === undefined) return;
		if (this.committedUrl) this.#forward.push(this.committedUrl);
		this.#commit(previous);
	}

	goForward(): void {
		const next = this.#forward.pop();
		if (next === undefined) return;
		if (this.committedUrl) this.#back.push(this.committedUrl);
		this.#commit(next);
	}

	clearRejection(): void {
		this.rejection = null;
	}

	setProjectState(_projectState: WorkspaceProjectState): void {}

	setPresentationVisible(_visible: boolean): void {}

	dispose(): void {
		this.rejection = null;
		this.#navigationSequence += 1;
	}

	#commit(url: string): void {
		this.committedUrl = url;
		this.inputValue = url;
		this.rejection = null;
		this.embedVerdict = null;
		this.frameGeneration += 1;
		this.canGoBack = this.#back.length > 0;
		this.canGoForward = this.#forward.length > 0;
		if (url.length <= MAX_PERSISTED_URL_LENGTH) {
			setLocalStorageItem(LOCAL_STORAGE_KEYS.browserSurface, JSON.stringify({ url }));
		} else {
			// Keeping the previous entry would restore an older page than the one
			// on screen, so an unpersistable URL clears it instead.
			removeLocalStorageItem(LOCAL_STORAGE_KEYS.browserSurface);
		}
		this.#probeEmbeddability(url);
	}

	#probeEmbeddability(url: string): void {
		// Claim the sequence before any skip check, so a URL that is never probed
		// still invalidates an in-flight probe for the previous one.
		const sequence = ++this.#navigationSequence;
		const probe = this.#embedProbe;
		// The server rejects over-long URLs, so skip a request that always fails.
		if (!probe || url.length > MAX_EMBED_CHECK_URL_LENGTH) return;
		// Deferred so a navigation later in the same tick supersedes this probe
		// before it costs a request: link capture constructs the controller
		// (restoring a URL) and immediately navigates away from it.
		queueMicrotask(() => {
			if (sequence !== this.#navigationSequence) return;
			void probe(url)
				.then((verdict) => {
					if (sequence !== this.#navigationSequence || verdict === null) return;
					this.embedVerdict = verdict;
				})
				.catch(() => {
					// Advisory only; probe failures never surface.
				});
		});
	}

	// Persisted state is a trust boundary: another tab or an older build may
	// have written it, so it re-validates through the URL policy.
	#readPersisted(): string | null {
		try {
			const raw = getLocalStorageItem(LOCAL_STORAGE_KEYS.browserSurface);
			if (!raw) return null;
			const parsed: unknown = JSON.parse(raw);
			const url =
				parsed && typeof parsed === 'object' && 'url' in parsed
					? (parsed as { url: unknown }).url
					: null;
			if (typeof url !== 'string' || url.length > MAX_PERSISTED_URL_LENGTH) return null;
			// Return the normalized href, never the raw stored string: a foreign
			// write could hold an acceptable-but-unnormalized value that would
			// resolve relative to the app origin as an iframe src.
			const result = normalizeBrowserUrl(url, this.#appOrigin);
			return result.ok ? result.url : null;
		} catch {
			return null;
		}
	}
}
