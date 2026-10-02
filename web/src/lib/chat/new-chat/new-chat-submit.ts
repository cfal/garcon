export type PathValidationStatus = 'idle' | 'checking' | 'valid' | 'invalid';

export function canSubmitNewChat(
	path: string,
	validationStatus: PathValidationStatus,
	firstMessage: string,
	attachmentCount = 0,
): boolean {
	return (
		Boolean(path.trim()) &&
		validationStatus === 'valid' &&
		(Boolean(firstMessage.trim()) || attachmentCount > 0)
	);
}
