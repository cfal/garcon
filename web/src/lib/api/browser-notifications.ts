import { apiDelete, apiGet, apiPost, apiPut } from './client.js';
import {
	normalizeRemoteSettingsSnapshot,
	type RemoteSettingsSnapshot,
} from '$shared/settings';
import type { BrowserNotificationDisplayMode } from '$shared/ws-requests';

export interface BrowserPushVapidPublicKeyResponse {
	publicKey: string;
}

export interface BrowserPushSubscriptionPayload {
	endpoint: string;
	expirationTime?: number | null;
	keys?: {
		p256dh?: string;
		auth?: string;
	};
}

export interface BrowserPushSubscriptionMutationResponse {
	success: boolean;
	endpointHash?: string;
	settings: RemoteSettingsSnapshot;
	error?: string;
}

export interface BrowserPushTestResponse {
	success: boolean;
	sent: number;
	failed: number;
	error?: string;
}

function normalizeMutationResponse(
	payload: BrowserPushSubscriptionMutationResponse,
): BrowserPushSubscriptionMutationResponse {
	const snapshot = normalizeRemoteSettingsSnapshot(payload.settings);
	if (!snapshot) {
		throw new Error('Invalid browser notification settings response');
	}
	return { ...payload, settings: snapshot };
}

export async function getBrowserPushVapidPublicKey(): Promise<string> {
	const response = await apiGet<BrowserPushVapidPublicKeyResponse>(
		'/api/v1/app/browser-notifications/vapid-public-key',
	);
	return response.publicKey;
}

export async function upsertBrowserPushSubscription(input: {
	subscription: BrowserPushSubscriptionPayload;
	clientId: string;
	displayMode: BrowserNotificationDisplayMode;
	platform: string;
}): Promise<BrowserPushSubscriptionMutationResponse> {
	const payload = await apiPut<BrowserPushSubscriptionMutationResponse>(
		'/api/v1/app/browser-notifications/subscription',
		input,
	);
	return normalizeMutationResponse(payload);
}

export async function deleteBrowserPushSubscription(input: {
	endpointHash?: string | null;
	endpoint?: string | null;
}): Promise<BrowserPushSubscriptionMutationResponse> {
	const payload = await apiDelete<BrowserPushSubscriptionMutationResponse>(
		'/api/v1/app/browser-notifications/subscription',
		input,
	);
	return normalizeMutationResponse(payload);
}

export async function sendBrowserNotificationTest(): Promise<BrowserPushTestResponse> {
	return apiPost<BrowserPushTestResponse>('/api/v1/app/browser-notifications/test');
}
