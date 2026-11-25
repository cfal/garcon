import {
	parseProjectResolutionResponse,
	projectTargetKey,
	type ProjectResolutionResponse,
	type ProjectTarget,
} from '$shared/project-resolution';
import { apiGet } from './client.js';

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
	query.set('executorId', target.executorId ?? 'local');
	const parsed = parseProjectResolutionResponse(
		await apiGet<unknown>(`/api/v1/projects/resolve?${query}`, { signal }),
	);
	if (!parsed || projectTargetKey(parsed.target) !== projectTargetKey(target)) {
		throw new Error('Invalid project resolution response');
	}
	return parsed;
}
