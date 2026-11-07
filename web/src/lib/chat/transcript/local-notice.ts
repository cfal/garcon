import type { ChatOperationalNoticeType } from '$shared/ws-events';

export type LocalNoticeType = ChatOperationalNoticeType | 'progress';

export interface LocalNoticeRow {
	id: string;
	kind: 'local-notice';
	noticeType: LocalNoticeType;
	content: string;
	timestamp: string;
	transcriptBarrier?: { readonly serverInstanceId: string; readonly transcriptViewId: string; readonly ordinal: number };
	contentDigest?: string;
}

export async function diagnosticDigest(content: string): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(content));
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
