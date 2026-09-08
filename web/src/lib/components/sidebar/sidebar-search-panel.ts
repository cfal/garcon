import type { SavedChatSearch } from '$lib/api/settings';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type {
	ChatSearchIndexStatus,
	ChatSearchResult,
	ChatSearchSort,
	TranscriptSearchStatusV1,
} from '$shared/chat-search';

export const SIDEBAR_SEARCH_DIALOG_CONTENT_CLASS =
	'top-[var(--app-viewport-center-y)] flex h-[var(--app-height)] max-h-[var(--app-height)] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:w-screen sm:max-w-none min-[769px]:pointer-fine:top-[50%] min-[769px]:pointer-fine:h-[min(44rem,calc(var(--app-height)-2rem))] min-[769px]:pointer-fine:max-h-[44rem] min-[769px]:pointer-fine:w-[calc(100vw-2rem)] min-[769px]:pointer-fine:max-w-3xl min-[769px]:pointer-fine:rounded-2xl min-[769px]:pointer-fine:border';

export interface SidebarSearchPanelProps {
	query: string;
	filteredChats: ChatSessionRecord[];
	savedSearches: SavedChatSearch[];
	transcriptMatchesByChatId?: Map<string, ChatSearchResult>;
	transcriptSearchEnabled?: boolean;
	transcriptSearchLoading?: boolean;
	transcriptSearchIndexing?: boolean;
	transcriptSearchIndex?: ChatSearchIndexStatus | null;
	transcriptSearchStatus?: TranscriptSearchStatusV1 | null;
	transcriptSearchError?: string | null;
	sort?: ChatSearchSort;
	showTranscriptPagination?: boolean;
	hasMoreTranscriptResults?: boolean;
	loadingMoreTranscriptResults?: boolean;
	transcriptSearchPageError?: string | null;
	transcriptSearchRevalidating?: boolean;
	transcriptSearchRevalidationError?: string | null;
	transcriptSearchLimitReached?: boolean;
	transcriptSearchAnnouncement?: string;
	transcriptSearchAnnouncementVersion?: number;
	resultsResetVersion?: number;
	revalidationVersion?: number;
	currentTime: Date;
	highlightedIndex: number;
	onQueryChange: (query: string) => void;
	onSelectChat: (chatId: string) => void;
	onApplySavedSearch: (search: SavedChatSearch) => void;
	onCreateSavedSearch: () => void;
	onOpenManager: () => void;
	onHighlightChange: (index: number) => void;
	onRetryTranscriptSearch?: () => void;
	onSortChange?: (sort: ChatSearchSort) => void;
	onLoadMoreTranscriptResults?: () => Promise<void> | void;
	onRetryTranscriptSearchRevalidation?: () => Promise<void> | void;
	onClose: () => void;
	showSavedSearchActions?: boolean;
	reduceMotion?: boolean;
}
