import type { SavedChatSearch } from '$lib/api/settings';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type {
	ChatSearchIndexStatus,
	ChatSearchResult,
	ChatSearchSort,
	TranscriptSearchStatusV1,
} from '$shared/chat-search';

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
