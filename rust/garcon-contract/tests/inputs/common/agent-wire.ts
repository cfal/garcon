import type {
  AgentAttachment, AgentAuthStatus, AgentCredentialReference, AgentEndpointSelection,
} from '../../../../../common/agent-execution.ts';
import {
  LOGIN_INSTANCE_QUERY, type AgentAuthLoginCompleteResult, type AgentAuthLoginHttpStatus,
  type AgentAuthLoginLaunchResult, type AgentAuthLoginStatus, type AgentDeviceAuthInfo,
} from '../../../../../common/agent-auth.ts';

const image: AgentAttachment = { kind: 'image', data: 'eA==', name: null, mimeType: 'image/png' };
const credential: AgentCredentialReference = {
  kind: 'api-provider-endpoint', apiProviderId: 'fixture-provider', endpointId: 'fixture-endpoint', revision: 9007199254740991,
};
const local: AgentEndpointSelection = {
  apiProviderId: 'fixture-provider', endpointId: 'fixture-local', providerLabel: 'Fixture',
  protocol: 'anthropic-messages', baseUrl: 'http://127.0.0.1:7000', model: 'fixture-model',
  isLocal: true, capabilities: null, headers: {}, credential: null,
};
const endpoint: AgentEndpointSelection = {
  ...local, endpointId: credential.endpointId, protocol: 'openai-compatible', isLocal: false,
  capabilities: { chatCompletions: true, responses: false },
  headers: { 'X-Fixture-One': 'value', 'X-Fixture-Two': 'another' }, credential,
};
const auth: AgentAuthStatus = { authenticated: true, canReauth: true, label: 'Fixture', source: 'api-key' };
const authWithDetail: AgentAuthStatus = { ...auth, authenticated: false, source: 'none', detail: 'Sign-in needed' };

const device: AgentDeviceAuthInfo = { url: 'https://example.test/device', code: 'AAAA-0000', needsCode: true };
const launch: AgentAuthLoginLaunchResult = { launched: true, alreadyRunning: false, sessionId: 'fixture-login', deviceAuth: device };
const repeat: AgentAuthLoginLaunchResult = { launched: false, alreadyRunning: true, sessionId: 'fixture-login' };
const idle: AgentAuthLoginStatus = { state: 'idle', running: false };
const running: AgentAuthLoginStatus = {
  state: 'running', running: true, sessionId: 'fixture-login', completionPending: true,
  retryableError: 'Try again', deviceAuth: device,
};
const succeeded: AgentAuthLoginStatus = { state: 'succeeded', running: false, sessionId: 'fixture-login' };
const failed: AgentAuthLoginStatus = { state: 'failed', running: false, sessionId: 'fixture-login', error: 'Login failed' };
const submitted: AgentAuthLoginCompleteResult = { submitted: true, sessionId: 'fixture-login' };
const confirmed: AgentAuthLoginHttpStatus = { ...succeeded, instanceId: 'fixture-instance' };

for (const value of [image, credential, local, endpoint, auth, authWithDetail]) {
  console.log(JSON.stringify(value));
}
for (const value of [device, launch, repeat, idle, running, succeeded, failed, submitted, confirmed, LOGIN_INSTANCE_QUERY]) {
  console.log(JSON.stringify(value));
}
