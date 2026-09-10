import { GitDomainError } from './git-types.js';
import type { AgentId } from '../../common/agents.ts';
import type {
  CommitMessageErrorCode, CommitMessageOptions, CommitMessageFileOptions,
  CommitMessageGenerationResult, GitAgentRunner, RunSingleQueryOptions,
} from './types.js';
import type { WorkspaceGitService } from '../execution-nodes/workspace-git.js';
import { applyDirPrefix, computeCommonDirPrefix } from './commit-prefix.js';
import { createLogger } from '../lib/log.js';
import { createGenerationRequestSignal, GENERATION_PROVIDER_TIMEOUT_MS } from '../settings/generation-limits.js';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import {
  COMMIT_MESSAGE_DIFF_TOKEN,
  COMMIT_MESSAGE_FILES_TOKEN,
  DEFAULT_COMMIT_MESSAGE_PROMPT,
} from '../../common/generation-prompts.js';

const logger = createLogger('git:commit-message');

const MAX_DIFF_CHARS = 80_000;

function classifyCommitMessageAgentError(error: unknown): CommitMessageErrorCode {
  if (!(error instanceof AgentIntegrationError)) return 'COMMIT_MESSAGE_GENERATION_FAILED';
  if (error.code === 'AUTH_REQUIRED') return 'COMMIT_MESSAGE_AGENT_AUTH_REQUIRED';
  if (error.code === 'RATE_LIMITED') return 'COMMIT_MESSAGE_RATE_LIMITED';
  if (error.code === 'TIMEOUT') return 'COMMIT_MESSAGE_TIMEOUT';
  if (error.code === 'BINARY_NOT_FOUND' || error.code === 'UNAVAILABLE') {
    return 'COMMIT_MESSAGE_AGENT_UNAVAILABLE';
  }
  return 'COMMIT_MESSAGE_GENERATION_FAILED';
}

export async function generateCommitMessageForFiles(
  git: Pick<WorkspaceGitService, 'captureCommitMessageSource'>,
  agents: GitAgentRunner,
  {
    projectPath, files, agentId, model, apiProviderId, modelEndpointId, modelProtocol,
    thinkingMode, customPrompt, useCommonDirPrefix, signal = createGenerationRequestSignal(),
  }: CommitMessageFileOptions,
): Promise<CommitMessageGenerationResult> {
  const captured = await git.captureCommitMessageSource({ projectPath, files: [...files], signal });
  signal.throwIfAborted();
  const capturedFiles = [...captured.files];
  const message = await generateCommitMessage(
    capturedFiles, captured.diffContext, agentId, captured.projectPath,
    (prompt, options) => agents.runSingleQuery(prompt, options),
    { model, apiProviderId, modelEndpointId, modelProtocol, thinkingMode, customPrompt, signal },
  );
  const directoryPrefix = useCommonDirPrefix ? computeCommonDirPrefix(capturedFiles) : '';
  return {
    message: directoryPrefix ? applyDirPrefix(message, directoryPrefix) : message,
    directoryPrefix,
  };
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
  const diffExcerpt = diffContext.substring(0, MAX_DIFF_CHARS);
  const {
    model,
    apiProviderId,
    modelEndpointId,
    modelProtocol,
    thinkingMode,
    customPrompt,
  } = options;

  const template = customPrompt?.trim() ? customPrompt : DEFAULT_COMMIT_MESSAGE_PROMPT;
  const prompt = template
    .replaceAll(COMMIT_MESSAGE_FILES_TOKEN, () => filesList)
    .replaceAll(COMMIT_MESSAGE_DIFF_TOKEN, () => diffExcerpt);

  try {
    const opts: RunSingleQueryOptions = {
      agentId,
      cwd: projectPath,
      thinkingMode: thinkingMode ?? 'none',
      timeoutMs: options.timeoutMs ?? GENERATION_PROVIDER_TIMEOUT_MS,
    };
    if (options.signal) opts.signal = options.signal;
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
