export type PathValidationStatus = 'idle' | 'checking' | 'valid' | 'invalid';

export function canSubmitNewChat(path: string, validationStatus: PathValidationStatus): boolean {
	return Boolean(path.trim()) && validationStatus === 'valid';
}
