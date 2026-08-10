import * as m from '$lib/paraglide/messages.js';

export type SteerSubmissionRejection =
	'prompt-required' | 'unsupported' | 'attachments-unavailable' | 'handoff-pending';

export function steerSubmissionRejection(input: {
	prompt: string;
	supportsSteering: boolean;
	attachmentCount: number;
	handoffPending: boolean;
}): SteerSubmissionRejection | null {
	if (input.prompt.trim().length === 0) return 'prompt-required';
	if (!input.supportsSteering) return 'unsupported';
	if (input.attachmentCount > 0) return 'attachments-unavailable';
	if (input.handoffPending) return 'handoff-pending';
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
		case 'handoff-pending':
			return m.chat_notice_handoff_requires_idle();
	}
}
