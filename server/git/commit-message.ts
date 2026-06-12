import { GitDomainError } from './git-types.js';
import type { AgentId } from '../../common/agents.ts';
import type { CommitMessageOptions, RunSingleQueryOptions } from './types.js';
import { createLogger } from '../lib/log.js';
import { errorMessage } from '../lib/errors.js';

const logger = createLogger('git:commit-message');

const DEFAULT_COMMIT_PROMPT = `Write a high-quality Conventional Commit message based on the staged changes.

Strict output rules:
- Return plain text only. Do not include markdown, code fences, labels, or commentary.
- First line must follow: type(scope): subject
- Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore
- Subject must be imperative, specific, and 50 characters or fewer
- Add a body only when it improves clarity; wrap body lines to 72 characters or fewer

Content guidance:
- Prioritize user-visible behavior changes
- Include critical technical context when behavior changes depend on it
- Reflect both additions and removals when relevant
- Avoid vague subjects such as "update files" or "misc changes"

Changed files:
{{files}}

Diff excerpt:
{{diff}}

Return only the commit message now.`;

export const COMMIT_MESSAGE_ERROR_MAP = Object.freeze({
  COMMIT_MESSAGE_NO_STAGED_FILES: { status: 400, errorCode: 'commit_message_no_staged_files' },
  COMMIT_MESSAGE_AGENT_AUTH_REQUIRED: { status: 401, errorCode: 'commit_message_agent_auth_required' },
  COMMIT_MESSAGE_RATE_LIMITED: { status: 429, errorCode: 'commit_message_rate_limited' },
  COMMIT_MESSAGE_AGENT_UNAVAILABLE: { status: 503, errorCode: 'commit_message_agent_unavailable' },
  COMMIT_MESSAGE_TIMEOUT: { status: 504, errorCode: 'commit_message_timeout' },
  COMMIT_MESSAGE_EMPTY_RESPONSE: { status: 502, errorCode: 'commit_message_empty_response' },
  COMMIT_MESSAGE_INVALID_RESPONSE: { status: 502, errorCode: 'commit_message_invalid_response' },
  COMMIT_MESSAGE_GENERATION_FAILED: { status: 500, errorCode: 'commit_message_generation_failed' },
});

type CommitMessageErrorCode = keyof typeof COMMIT_MESSAGE_ERROR_MAP;

export function isCommitMessageErrorCode(code: string): code is CommitMessageErrorCode {
  return Object.prototype.hasOwnProperty.call(COMMIT_MESSAGE_ERROR_MAP, code);
}

function classifyCommitMessageAgentError(error: unknown): CommitMessageErrorCode {
  const message = errorMessage(error).toLowerCase();
  if (
    message.includes('401')
    || message.includes('unauthorized')
    || message.includes('forbidden')
    || message.includes('auth')
    || message.includes('login')
    || message.includes('api key')
  ) {
    return 'COMMIT_MESSAGE_AGENT_AUTH_REQUIRED';
  }
  if (
    message.includes('429')
    || message.includes('rate limit')
    || message.includes('quota')
    || message.includes('too many requests')
  ) {
    return 'COMMIT_MESSAGE_RATE_LIMITED';
  }
  if (
    message.includes('timed out')
    || message.includes('timeout')
    || message.includes('deadline')
    || message.includes('etimedout')
  ) {
    return 'COMMIT_MESSAGE_TIMEOUT';
  }
  if (
    message.includes('service unavailable')
    || message.includes('unavailable')
    || message.includes('econnrefused')
    || message.includes('enotfound')
    || message.includes('network')
    || message.includes('failed to create opencode session')
  ) {
    return 'COMMIT_MESSAGE_AGENT_UNAVAILABLE';
  }
  return 'COMMIT_MESSAGE_GENERATION_FAILED';
}

// Generates a conventional commit message using the configured agent.
// When customPrompt is non-empty, it is used as the template with
// {{files}} and {{diff}} placeholders substituted in.
export async function generateCommitMessage(
  files: string[],
  diffContext: string,
  agentId: AgentId,
  projectPath: string,
  runSingleQueryFn: (prompt: string, options: RunSingleQueryOptions) => Promise<string>,
  options: CommitMessageOptions = {},
): Promise<string> {
  const filesList = files.map((f) => `- ${f}`).join('\n');
  const diffExcerpt = diffContext.substring(0, 4000);
  const { model, apiProviderId, modelEndpointId, modelProtocol, customPrompt } = options;

  let prompt;
  if (customPrompt && customPrompt.trim()) {
    prompt = customPrompt
      .replace(/\{\{files\}\}/g, filesList)
      .replace(/\{\{diff\}\}/g, diffExcerpt);
  } else {
    prompt = DEFAULT_COMMIT_PROMPT
      .replace(/\{\{files\}\}/g, filesList)
      .replace(/\{\{diff\}\}/g, diffExcerpt);
  }

  try {
    const opts: RunSingleQueryOptions = { agentId, cwd: projectPath };
    if (model) opts.model = model;
    if (apiProviderId) opts.apiProviderId = apiProviderId;
    if (modelEndpointId) opts.modelEndpointId = modelEndpointId;
    if (modelProtocol) opts.modelProtocol = modelProtocol;
    const responseText = await runSingleQueryFn(prompt, opts);
    if (!responseText?.trim()) {
      throw new GitDomainError('COMMIT_MESSAGE_EMPTY_RESPONSE', 'Provider returned an empty commit message response.');
    }
    const cleaned = normalizeCommitMessage(responseText);
    if (!cleaned) {
      throw new GitDomainError('COMMIT_MESSAGE_INVALID_RESPONSE', 'Provider returned an invalid commit message format.');
    }
    return cleaned;
  } catch (error) {
    if (error instanceof GitDomainError) throw error;
    logger.error('Error generating commit message:', error);
    throw new GitDomainError(
      classifyCommitMessageAgentError(error),
      'Failed to generate commit message.',
    );
  }
}

// Extracts a conventional commit message from AI-generated text by
// stripping fences, markdown headers, and leading non-commit prose.
function normalizeCommitMessage(text: string): string {
  if (!text?.trim()) return '';

  const lines = text.trim().split('\n');
  const cleaned = [];
  let foundCommit = false;

  for (const raw of lines) {
    if (raw.startsWith('```')) continue;
    const line = raw.replace(/^#+\s*/, '');

    if (!foundCommit && /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.+?\))?:/.test(line)) {
      foundCommit = true;
    }
    if (foundCommit) cleaned.push(line);
  }

  const result = cleaned.length > 0 ? cleaned : lines.filter((l) => !l.startsWith('```'));

  if (result.length > 0) {
    result[0] = result[0].replace(/^["']|["']$/g, '');
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
