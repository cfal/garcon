// Captures the installed SDK's request before fetching. No provider process or
// network access is required to record these method, URL, and body bytes.
import { createOpencodeClient } from '../../../../server-agents/opencode/node_modules/@opencode-ai/sdk/dist/v2/client.js';

export async function sdkRequest(operation: string, params: Record<string, unknown>) {
  let observed: { method: string; target: string; contentType: string | null; body: string | null } | undefined;
  const client = createOpencodeClient({
    baseUrl: 'http://127.0.0.1:9911',
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      observed = {
        method: request.method,
        target: url.pathname + url.search,
        contentType: request.headers.get('content-type'),
        body: request.body === null ? null : await request.text(),
      };
      return Response.json({});
    },
  });
  const methods = {
    ConfigProviders: [client.config, 'providers'],
    ProviderList: [client.provider, 'list'],
    SessionCreate: [client.session, 'create'],
    SessionDelete: [client.session, 'delete'],
    SessionGet: [client.session, 'get'],
    SessionUpdate: [client.session, 'update'],
    SessionMessages: [client.session, 'messages'],
    SessionPrompt: [client.session, 'prompt'],
    SessionPromptAsync: [client.session, 'promptAsync'],
    SessionFork: [client.session, 'fork'],
    SessionAbort: [client.session, 'abort'],
    SessionSummarize: [client.session, 'summarize'],
    SessionRevert: [client.session, 'revert'],
    MoveSession: [client.experimental.controlPlane, 'moveSession'],
    PermissionReply: [client.permission, 'reply'],
    QuestionReply: [client.question, 'reply'],
    QuestionReject: [client.question, 'reject'],
    ShowToast: [client.tui, 'showToast'],
  } as const;
  const [owner, method] = methods[operation as keyof typeof methods];
  await (owner as unknown as Record<string, (p: Record<string, unknown>) => unknown>)[method](params);
  if (!observed) throw new Error('SDK did not send a request');
  return observed;
}
