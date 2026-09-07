import {
	calculateChatTagTransition,
	tagSetMatchesBoardColumn,
	type ChatBoard,
	type ChatBoardColumn,
	type ChatTagTransitionPreview,
} from '$shared/chat-boards';

export interface ChatBoardTransitionProjection extends ChatTagTransitionPreview {
	readonly appliedTargetTags: readonly string[];
	readonly matchingColumnIds: readonly string[];
	readonly sourceStillMatches: boolean;
	readonly isNoop: boolean;
}

export function initialTargetTags(
	currentTags: readonly string[],
	target: ChatBoardColumn,
): readonly string[] {
	if (target.match === 'all') return target.tags;
	const current = new Set(currentTags);
	return target.tags.filter((tag) => current.has(tag));
}

export function projectChatBoardTransition(input: {
	readonly board: ChatBoard;
	readonly source: ChatBoardColumn;
	readonly target: ChatBoardColumn;
	readonly currentTags: readonly string[];
	readonly selectedTargetTags: readonly string[];
}): ChatBoardTransitionProjection {
	const appliedTargetTags =
		input.target.match === 'all'
			? input.target.tags
			: input.target.tags.filter((tag) => input.selectedTargetTags.includes(tag));
	const preview = calculateChatTagTransition({
		currentTags: input.currentTags,
		sourceTags: input.source.tags,
		appliedTargetTags,
	});
	const resulting = new Set(preview.resultingTags);
	const matchingColumnIds = input.board.columns
		.filter((column) => tagSetMatchesBoardColumn(resulting, column))
		.map((column) => column.id);
	return {
		...preview,
		appliedTargetTags,
		matchingColumnIds,
		sourceStillMatches: matchingColumnIds.includes(input.source.id),
		isNoop: preview.addedTags.length === 0 && preview.removedTags.length === 0,
	};
}
