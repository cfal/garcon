import { asyncQuestionReplyText, type AsyncQuestionReply } from '$shared/async-user-questions';
import { nextRunOrSteerRoute, RUN_OR_STEER_MAX_ATTEMPTS, RUN_OR_STEER_RETRY_DELAY_MS } from '$shared/run-or-steer';
import { ApiError } from '$lib/api/client.js';
import { AcceptedInputSubmissionService } from './accepted-input-submission-service.js';

export interface AsyncQuestionTarget {
	chatId: string;
	transcriptViewId: string;
	expectedAgentId: string;
	expectedAgentOwnershipEpoch: string;
}

export async function submitAsyncQuestionReply(
	target: AsyncQuestionTarget,
	questionReply: AsyncQuestionReply,
	excludedResendOrdinals: readonly number[] = [],
	inputs: Pick<AcceptedInputSubmissionService, 'run' | 'steer'> = new AcceptedInputSubmissionService(),
): Promise<'new-turn' | 'steer'> {
	const content = asyncQuestionReplyText(questionReply);
	const common = { ...target, questionReply };
	const run = inputs.run({ ...common, command: content, excludedResendOrdinals: [...excludedResendOrdinals] });
	let route: 'run' | 'steer' = 'run';
	for (let attempt = 0; ; attempt += 1) {
		try {
			if (route === 'run') {
				await run.submit();
				return 'new-turn';
			}
			await inputs.steer({ ...common, content, whenTurnUnavailable: 'reject' }).submit();
			return 'steer';
		} catch (error) {
			if (!(error instanceof ApiError)) throw error;
			const next = nextRunOrSteerRoute(route, error.status, error.errorCode);
			if (!next || attempt + 1 >= RUN_OR_STEER_MAX_ATTEMPTS) throw error;
			route = next;
			await new Promise(resolve => setTimeout(resolve, RUN_OR_STEER_RETRY_DELAY_MS));
		}
	}
}
