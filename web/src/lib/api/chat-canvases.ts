import {
	parseCanvasList,
	parseChatCanvas,
	type CreateCanvasRequest,
	type UpdateCanvasRequest,
	type DeleteCanvasRequest,
} from '$shared/chat-canvas';
import { apiDelete, apiGet, apiPost, apiPut } from './client.js';

const endpoint = '/api/v1/chat-canvases';

export async function listCanvases() {
	return parseCanvasList(await apiGet<unknown>(endpoint));
}

export async function getCanvas(id: string) {
	return parseChatCanvas(await apiGet<unknown>(`${endpoint}?id=${encodeURIComponent(id)}`));
}

export async function createCanvas(request: CreateCanvasRequest) {
	return parseChatCanvas(await apiPost<unknown>(endpoint, request));
}

export async function updateCanvas(request: UpdateCanvasRequest) {
	return parseChatCanvas(await apiPut<unknown>(endpoint, request));
}

export async function deleteCanvas(request: DeleteCanvasRequest): Promise<void> {
	const response = await apiDelete<{ success?: unknown }>(endpoint, request);
	if (response?.success !== true) throw new Error('Invalid canvas deletion response');
}
