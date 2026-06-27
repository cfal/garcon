interface ForkActionInput {
	supportsFork: boolean;
	supportsForkWhileRunning: boolean;
	isProcessing: boolean;
}

interface ForkAtMessageActionInput {
	supportsForkAtMessage: boolean;
	supportsForkWhileRunning: boolean;
	isProcessing: boolean;
}

function canForkInCurrentRunState(input: { isProcessing: boolean; supportsForkWhileRunning: boolean }): boolean {
	return !input.isProcessing || input.supportsForkWhileRunning;
}

export function canUseForkAction(input: ForkActionInput): boolean {
	return input.supportsFork && canForkInCurrentRunState(input);
}

export function canShowForkAtMessageAction(input: Pick<ForkAtMessageActionInput, 'supportsForkAtMessage'>): boolean {
	return input.supportsForkAtMessage;
}

export function canUseForkAtMessageAction(input: ForkAtMessageActionInput): boolean {
	return input.supportsForkAtMessage && canForkInCurrentRunState(input);
}
