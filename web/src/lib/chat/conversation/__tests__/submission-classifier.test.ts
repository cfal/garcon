import { describe, expect, it } from 'vitest';
import { emptyChatExecutionControlState } from '$shared/chat-execution-control';
import { classifySubmission, type SubmissionClassificationInput } from '../submission-classifier.js';

function input(
	overrides: Partial<SubmissionClassificationInput> = {},
): SubmissionClassificationInput {
	return {
		isDraft: false,
		isProcessing: false,
		control: emptyChatExecutionControlState(),
		isActiveDeliveryInput: false,
		isRecoveredContinuationEligible: true,
		hasAttachments: false,
		...overrides,
	};
}

describe('classifySubmission', () => {
	it.each([
		['draft chat', input({ isDraft: true }), 'draft'],
		['idle chat', input(), 'direct'],
		[
			'empty recovered continuation',
			input({
				control: {
					...emptyChatExecutionControlState(),
					recoveredInputContinuation: {
						id: 'continuation-1',
						installedAt: '2026-07-19T00:00:00.000Z',
					},
				},
			}),
			'direct',
		],
		[
			'ineligible recovered continuation',
			input({
				isRecoveredContinuationEligible: false,
				control: {
					...emptyChatExecutionControlState(),
					recoveredInputContinuation: {
						id: 'continuation-1',
						installedAt: '2026-07-19T00:00:00.000Z',
					},
				},
			}),
			'queue',
		],
		[
			'active steering input',
			input({ isProcessing: true, isActiveDeliveryInput: true }),
			'active',
		],
		['ordinary active-turn input', input({ isProcessing: true }), 'queue'],
		[
			'queued predecessor',
			input({
				control: {
					...emptyChatExecutionControlState(),
					queue: {
						...emptyChatExecutionControlState().queue,
						entries: [
							{
								id: 'entry-1',
								content: 'first',
								revision: 1,
								createdAt: '2026-07-19T00:00:00.000Z',
								updatedAt: '2026-07-19T00:00:00.000Z',
							},
						],
					},
				},
			}),
			'queue',
		],
		[
			'paused queue',
			input({
				control: {
					...emptyChatExecutionControlState(),
					queue: {
						...emptyChatExecutionControlState().queue,
						pause: {
							id: 'pause-1',
							kind: 'manual',
							pausedAt: '2026-07-19T00:00:00.000Z',
						},
					},
				},
			}),
			'queue',
		],
		[
			'attachments requiring queue',
			input({ isProcessing: true, hasAttachments: true }),
			'queue-attachments-unsupported',
		],
	] as const)('routes %s', (_name, classification, expected) => {
		expect(classifySubmission(classification)).toBe(expected);
	});
});
