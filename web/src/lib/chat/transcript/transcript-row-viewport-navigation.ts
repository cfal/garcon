import { tick } from 'svelte';
import type { ConversationViewportPort } from './conversation-viewport-port.js';
import type {
	TranscriptRowNavigationResult,
	TranscriptRowTarget,
	TranscriptRowWindowResult,
} from './transcript-row-navigation.js';
import type {
	UserMessageNavigatorSelectionResult,
	UserMessageNavigatorTarget,
} from './user-message-navigator-controller.svelte.js';

interface RowViewportPort {
	viewId(): string;
	viewport(): ConversationViewportPort | null;
}

export async function jumpToLoadedTranscriptRow(
	target: UserMessageNavigatorTarget,
	options: { viewportOffset?: number },
	current: () => boolean,
	port: RowViewportPort & {
		readonly wasPinned: boolean;
		preserveHistoryBrowsing(): void;
		setPinned(pinned: boolean): void;
	},
): Promise<UserMessageNavigatorSelectionResult> {
	await tick();
	if (!current() || port.viewId() !== target.transcriptViewId) return 'cancelled';
	const viewport = port.viewport();
	if (!viewport) return 'unavailable';
	port.preserveHistoryBrowsing();
	const result = await viewport.scrollToTarget(
		{ kind: 'row', id: target.rowId },
		options.viewportOffset === undefined
			? { align: 'center' }
			: { viewportOffset: options.viewportOffset },
	);
	if (!current() || result === 'cancelled') return 'cancelled';
	if (result !== 'completed') {
		if (port.wasPinned) {
			viewport.scrollToEnd();
			port.setPinned(true);
		}
		return 'unavailable';
	}
	port.setPinned(viewport.isAtEnd());
	return 'completed';
}

export async function navigateTranscriptRowViewport(
	target: TranscriptRowTarget,
	current: () => boolean,
	loadWindow: (isCurrent: () => boolean) => Promise<TranscriptRowWindowResult>,
	port: RowViewportPort & {
		windowLoaded(): void;
	},
): Promise<TranscriptRowNavigationResult> {
	if (!current()) return 'cancelled';
	const result = await loadWindow(current);
	if (!current()) return 'cancelled';
	if (result !== 'loaded') return result;
	port.windowLoaded();
	await tick();
	if (!current()) return 'cancelled';
	if (port.viewId() !== target.transcriptViewId) return 'view-changed';
	const viewport = port.viewport();
	if (!viewport) return 'unavailable';
	const scrolled = await viewport.scrollToTarget(
		{ kind: 'row', id: `${target.transcriptViewId}:${target.ordinal}` },
		{ align: 'center' },
	);
	if (!current()) return 'cancelled';
	if (port.viewId() !== target.transcriptViewId) return 'view-changed';
	return scrolled === 'completed' || scrolled === 'cancelled' ? scrolled : 'unavailable';
}
