import { apiDelete, apiGet, apiPatch, apiPost } from './client.js';
import {
	parseTerminalCreateResponse,
	parseTerminalListResponse,
	parseTerminalRenameResponse,
	parseTerminalTerminateResponse,
} from '$shared/terminal';
import type {
	TerminalCreateRequest,
	TerminalCreateResponse,
	TerminalListResponse,
	TerminalRenameRequest,
	TerminalRenameResponse,
	TerminalTerminateRequest,
	TerminalTerminateResponse,
} from '$shared/terminal';

export async function listTerminals(): Promise<TerminalListResponse> {
	const value = await apiGet<unknown>('/api/v1/terminals');
	const parsed = parseTerminalListResponse(value);
	if (!parsed) throw new Error('Invalid terminal list response');
	return parsed;
}

export async function createTerminal(
	request: TerminalCreateRequest,
): Promise<TerminalCreateResponse> {
	const value = await apiPost<unknown>('/api/v1/terminals', request);
	const parsed = parseTerminalCreateResponse(value);
	if (!parsed) throw new Error('Invalid terminal create response');
	return parsed;
}

export async function terminateTerminal(
	request: TerminalTerminateRequest,
): Promise<TerminalTerminateResponse> {
	const value = await apiDelete<unknown>('/api/v1/terminals', request);
	const parsed = parseTerminalTerminateResponse(value);
	if (!parsed) throw new Error('Invalid terminal terminate response');
	return parsed;
}

export async function renameTerminal(
	request: TerminalRenameRequest,
): Promise<TerminalRenameResponse> {
	const value = await apiPatch<unknown>('/api/v1/terminals', request);
	const parsed = parseTerminalRenameResponse(value);
	if (!parsed || parsed.terminalId !== request.terminalId) {
		throw new Error('Invalid terminal rename response');
	}
	return parsed;
}
