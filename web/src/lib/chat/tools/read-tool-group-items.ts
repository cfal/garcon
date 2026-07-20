import type { ReadToolUseMessage } from '$shared/chat-types';
import { readRangePresenter } from '$lib/chat/tools/tool-display-presenters.js';

export interface ReadToolGroupRenderItem {
	key: string;
	message: ReadToolUseMessage;
	filePath: string;
	displayName: string;
	rangeLabel?: string;
	isUnknown: boolean;
}

export interface ReadToolGroupSummary {
	totalCount: number;
	unknownCount: number;
	label: string;
}

function fileCountLabel(count: number): string {
	return count === 1 ? 'file' : 'files';
}

function readFilePath(message: ReadToolUseMessage): string {
	return message.filePath.trim();
}

function readFileDisplayName(filePath: string): string {
	return filePath.split('/').pop() || filePath;
}

export function summarizeReadToolGroup(messages: ReadToolUseMessage[]): ReadToolGroupSummary {
	const totalCount = messages.length;
	const unknownCount = messages.filter((message) => readFilePath(message).length === 0).length;
	const fileLabel = fileCountLabel(totalCount);

	if (unknownCount === totalCount) {
		return {
			totalCount,
			unknownCount,
			label: `${totalCount} unknown ${fileLabel}`,
		};
	}

	if (unknownCount > 0) {
		return {
			totalCount,
			unknownCount,
			label: `${totalCount} ${fileLabel} (${unknownCount} unknown)`,
		};
	}

	return {
		totalCount,
		unknownCount,
		label: `${totalCount} ${fileLabel}`,
	};
}

export function buildReadToolGroupRenderItems(
	messages: ReadToolUseMessage[],
): ReadToolGroupRenderItem[] {
	const seen = new Map<string, number>();
	return messages.map((message, index) => {
		const baseKey = message.toolId || `missing-tool-id-${index}`;
		const duplicateIndex = seen.get(baseKey) ?? 0;
		seen.set(baseKey, duplicateIndex + 1);
		const key = duplicateIndex === 0 ? baseKey : `${baseKey}#${duplicateIndex}`;
		const filePath = readFilePath(message);
		return {
			key,
			message,
			filePath,
			displayName: filePath ? readFileDisplayName(filePath) : 'Unknown file',
			rangeLabel: readRangePresenter(message),
			isUnknown: filePath.length === 0,
		};
	});
}
