interface ForkAtMessageActionInput {
	supportsForkAtMessage: boolean;
	supportsForkWhileRunning: boolean;
	isProcessing: boolean;
}

export function canShowForkAtMessageAction(input: ForkAtMessageActionInput): boolean {
	return input.supportsForkAtMessage && (!input.isProcessing || input.supportsForkWhileRunning);
}
