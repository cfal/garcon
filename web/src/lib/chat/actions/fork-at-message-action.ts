interface ForkActionInput {
	supportsFork: boolean;
	isProcessing: boolean;
}

interface ForkAtMessageActionInput {
	supportsForkAtMessage: boolean;
	supportsForkAtMessageWhileRunning: boolean;
	isProcessing: boolean;
}

function canForkInCurrentRunState(input: {
	isProcessing: boolean;
	supportsForkAtMessageWhileRunning: boolean;
}): boolean {
	return !input.isProcessing || input.supportsForkAtMessageWhileRunning;
}

export function canUseForkAction(input: ForkActionInput): boolean {
	return input.supportsFork && !input.isProcessing;
}

export function canShowForkAtMessageAction(
	input: Pick<ForkAtMessageActionInput, 'supportsForkAtMessage'>,
): boolean {
	return input.supportsForkAtMessage;
}

export function canUseForkAtMessageAction(input: ForkAtMessageActionInput): boolean {
	return input.supportsForkAtMessage && canForkInCurrentRunState(input);
}
