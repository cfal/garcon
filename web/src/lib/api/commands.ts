// Slash-command API for the chat composer's "/" autocomplete.

import { apiGet, type ApiFetchOptions } from './client.js';
import type { SlashCommand, SlashCommandsResponse } from '$shared/slash-commands';

export type { SlashCommand, SlashCommandSource } from '$shared/slash-commands';

export interface SlashCommandParams {
	agent: string;
	chatId?: string | null;
	projectPath?: string | null;
}

/** Fetches the slash commands available for a project's agent. */
export async function getSlashCommands(
	params: SlashCommandParams,
	options?: ApiFetchOptions,
): Promise<SlashCommand[]> {
	const query = new URLSearchParams();
	query.append('agent', params.agent);
	if (params.chatId) query.append('chatId', params.chatId);
	else if (params.projectPath) query.append('projectPath', params.projectPath);

	const response = await apiGet<SlashCommandsResponse>(
		`/api/v1/commands?${query.toString()}`,
		options,
	);
	return response.commands;
}
