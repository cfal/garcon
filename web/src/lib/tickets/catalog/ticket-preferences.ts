import { TICKET_PREFERENCES_STORAGE_KEY } from '../ticket-storage.js';
import { parseTicketListQuery } from '$shared/ticket-query';
import type { TicketListQuery } from '$shared/tickets';
import type { TicketLayout } from './ticket-collection.js';
import { canPersistBrowserData } from '$lib/utils/browser-data-lifetime';

export interface TicketPreferences {
	readonly layout: TicketLayout;
	readonly query: TicketListQuery;
	readonly detailFullWidth?: boolean;
}
export interface TicketPreferencesPort {
	read(): TicketPreferences;
	write(preferences: TicketPreferences): void;
}
export const browserTicketPreferences: TicketPreferencesPort = {
	read() {
		try {
			const raw = JSON.parse(globalThis.localStorage.getItem(TICKET_PREFERENCES_STORAGE_KEY) ?? 'null');
			if (raw?.version !== 1 || (raw.layout !== 'list' && raw.layout !== 'board'))
				return { layout: 'list', query: {} };
			const {
				beforeNumber: _cursor,
				expectedCollectionRevision: _revision,
				limit: _limit,
				...query
			} = parseTicketListQuery(raw.query);
			return { layout: raw.layout, query, detailFullWidth: raw.detailFullWidth === true };
		} catch {
			return { layout: 'list', query: {} };
		}
	},
	write(preferences) {
		if (!canPersistBrowserData()) return;
		try {
			globalThis.localStorage.setItem(
				TICKET_PREFERENCES_STORAGE_KEY,
				JSON.stringify({ version: 1, ...preferences }),
			);
		} catch {
			/* Preferences are optional; drafts have a separate recovery owner. */
		}
	},
};
