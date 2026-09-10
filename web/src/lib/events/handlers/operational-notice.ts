import type { ChatOperationalNoticeMessage } from '$shared/ws-events';
import type { ProjectUnavailableReason } from '$shared/project-resolution';
import * as m from '$lib/paraglide/messages.js';

function projectUnavailableContent(reason: ProjectUnavailableReason, projectPath: string): string {
	switch (reason) {
		case 'not-found':
			return m.chat_notice_project_not_found({ projectPath });
		case 'not-a-directory':
			return m.chat_notice_project_not_a_directory({ projectPath });
		case 'outside-base':
			return m.chat_notice_project_outside_base({ projectPath });
		case 'permission-denied':
			return m.chat_notice_project_permission_denied({ projectPath });
	}
}

export function operationalNoticeContent(message: ChatOperationalNoticeMessage): string {
	switch (message.detail?.type) {
		case 'carryover-compaction-started':
			return m.chat_notice_compacting_history();
		case 'native-transcript-drift':
			return m.chat_notice_native_transcript_drift();
		case 'project-unavailable':
			return projectUnavailableContent(message.detail.reason, message.detail.projectPath);
		default:
			return message.content;
	}
}
