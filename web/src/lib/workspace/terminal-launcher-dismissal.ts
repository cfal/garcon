interface TerminalLauncherDismissal {
	clientId: string;
	dismissed: true;
}

export function serializeTerminalLauncherDismissal(clientId: string): string {
	return JSON.stringify({ clientId, dismissed: true } satisfies TerminalLauncherDismissal);
}

export function isTerminalLauncherDismissed(raw: string | null, clientId: string | null): boolean {
	if (!raw || !clientId) return false;
	try {
		const value = JSON.parse(raw) as unknown;
		return (
			typeof value === 'object' &&
			value !== null &&
			'clientId' in value &&
			value.clientId === clientId &&
			'dismissed' in value &&
			value.dismissed === true
		);
	} catch {
		return false;
	}
}
