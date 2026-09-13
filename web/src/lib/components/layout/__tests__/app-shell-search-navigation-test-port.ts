import { vi } from 'vitest';
import type { SearchResultNavigationPort } from '$lib/sidebar/search/search-result-navigation-controller.js';

export const searchNavigationPort = {
	open: vi.fn<SearchResultNavigationPort['open']>().mockResolvedValue(),
	cancel: vi.fn<SearchResultNavigationPort['cancel']>(),
} satisfies SearchResultNavigationPort;
