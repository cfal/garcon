import {
	parseProjectResolutionResponse,
	projectTargetKey,
	type ProjectResolutionResponse,
	type ProjectTarget,
} from '$shared/project-resolution';
import { apiFetch, parseApiResponse } from './client.js';

export async function resolveProject(
	target: ProjectTarget,
	signal: AbortSignal,
): Promise<ProjectResolutionResponse> {
	const query = target.kind === 'chat'
		? new URLSearchParams({
				chatId: target.chatId,
				expectedProjectPath: target.projectPath,
			})
		: new URLSearchParams({ projectPath: target.projectPath });
	const response = await apiFetch(`/api/v1/projects/resolve?${query}`, { signal });
	const parsed = parseProjectResolutionResponse(await parseApiResponse<unknown>(response));
	if (!parsed || projectTargetKey(parsed.target) !== projectTargetKey(target)) {
		throw new Error('Invalid project resolution response');
	}
	return parsed;
}
