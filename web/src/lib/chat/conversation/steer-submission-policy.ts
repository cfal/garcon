import * as m from '$lib/paraglide/messages.js';

export type SteerSubmissionRejection =
	'prompt-required' | 'unsupported' | 'attachments-unavailable';

export function steerSubmissionRejection(input: {
	prompt: string;
	supportsSteering: boolean;
	attachmentCount: number;
}): SteerSubmissionRejection | null {
	if (input.prompt.trim().length === 0) return 'prompt-required';
	if (!input.supportsSteering) return 'unsupported';
	if (input.attachmentCount > 0) return 'attachments-unavailable';
	return null;
}

export function steerSubmissionRejectionNotice(rejection: SteerSubmissionRejection): string {
	switch (rejection) {
		case 'prompt-required':
			return m.chat_notice_steer_prompt_required();
		case 'unsupported':
			return m.chat_notice_steer_unsupported();
		case 'attachments-unavailable':
			return m.chat_notice_steer_attachments_unavailable();
	}
}

export function steerShortcutRejectionNotice(rejection: SteerSubmissionRejection): string {
	if (rejection === 'unsupported') return m.chat_notice_steer_shortcut_unsupported();
	return steerSubmissionRejectionNotice(rejection);
}
