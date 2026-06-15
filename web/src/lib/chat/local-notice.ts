export type LocalNoticeType = 'info' | 'progress' | 'warning' | 'error';

export interface LocalNoticeRow {
	id: string;
	kind: 'local-notice';
	noticeType: LocalNoticeType;
	content: string;
	timestamp: string;
}
