#!/usr/bin/env bun
import { watch } from 'node:fs';
// Synthetic GitHub CLI. Reads `gh-fixture.json` from the working directory and
// keeps posted comments in `gh-comments.json` beside it so writes can be read back.
const cwd = process.cwd();
const config = await Bun.file(`${cwd}/gh-fixture.json`).json();
const args = process.argv.slice(2);
const [command, action] = args;
await import('node:fs/promises').then(fs => fs.appendFile(`${cwd}/gh-calls.jsonl`, `${JSON.stringify(args)}\n`));
if (config.wait) {
  await Bun.write(`${cwd}/gh-started`, 'ready');
  await new Promise(resolve => setTimeout(resolve, 60_000));
}
const owner = config.owner ?? config.label;
const repository = config.repository ?? 'repository';
const login = config.login ?? config.label;
const actor = { id: config.viewerId ?? `actor:${login}`, login };
const host = config.host ?? 'git.example.invalid';
const repo = { nameWithOwner: `${owner}/${repository}`, url: `https://${host}/${owner}/${repository}` };
const defaultPull = { number: 1, title: config.label, author: { login: config.label } };
const pulls = (config.pulls ?? [defaultPull]).map(pull => ({
  title: `Pull request ${pull.number}`, body: 'x'.repeat(config.bodyBytes ?? 0), state: 'OPEN', isDraft: false,
  author: { login, __typename: 'User' }, authorAssociation: 'MEMBER', headRefName: 'feature', baseRefName: 'main',
  headRefOid: 'a'.repeat(40), isCrossRepository: false, additions: 1, deletions: 1, changedFiles: 1, reviewDecision: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  url: `https://git.example.invalid/${owner}/${repository}/pull/${pull.number}`,
  files: config.files ?? [{ path: 'example.txt', additions: 1, deletions: 1 }],
  labels: [], reviewRequests: [], checks: null,
  ...pull,
}));
const commentsFile = `${cwd}/gh-comments.json`;
const readComments = async () => (await Bun.file(commentsFile).exists()) ? Bun.file(commentsFile).json() : (config.comments ?? []);
const field = (name) => {
  for (let index = 0; index < args.length - 1; index++) {
    if ((args[index] === '-f' || args[index] === '-F') && args[index + 1].startsWith(`${name}=`)) return args[index + 1].slice(name.length + 1);
  }
  return undefined;
};
const print = (value) => console.log(JSON.stringify(value));
const fail = (message) => { console.error(message); process.exit(1); };
const findPull = (number) => pulls.find(pull => pull.number === Number(number)) ?? fail('GraphQL: Could not resolve to a PullRequest with the number.');

const page = (values, cursor = Number(field('endCursor') ?? 0), limit = config.pageSize ?? 100) => ({
  nodes: values.slice(cursor, cursor + limit),
  pageInfo: config.incompleteConnection ? null : { hasNextPage: cursor + limit < values.length, endCursor: String(cursor + limit) },
});
const listPull = ({ files, body, labels, reviewRequests, checks, teamReviewRequested, ...pull }) => ({
  ...pull,
  labels: page(labels.map(name => ({ name })), 0),
  reviewRequests: page(reviewRequests.map(reviewer => ({ requestedReviewer: { __typename: 'User', login: reviewer } })), 0),
  commits: { nodes: [{ commit: { statusCheckRollup: checks ? { state: checks } : null } }] },
});

if (config.fail?.[`${command} ${action}`] || config.fail?.[command]) fail(config.fail[`${command} ${action}`] ?? config.fail[command]);
if (command === 'auth') print({ hosts: { [host]: [{ active: true, state: 'success', login }] } });
else if (command === 'repo') print(repo);
else if (command === 'api' && action === 'graphql') {
  const query = field('query') ?? '';
  if (query === 'query{viewer{id login}}' && config.holdPostingActor) {
    const released = Promise.withResolvers();
    const watcher = watch(cwd, (_event, filename) => { if (filename === 'gh-actor-release') released.resolve(); });
    try {
      await Bun.write(`${cwd}/gh-actor-started`, 'ready');
      if (!await Bun.file(`${cwd}/gh-actor-release`).exists()) await released.promise;
    } finally { watcher.close(); }
  }
  if (query.startsWith('mutation')) {
    const comments = await readComments();
    const comment = comments.find(entry => entry.id === field('id')) ?? fail('GraphQL: Could not resolve to a node with the global id.');
    comment.isMinimized = true;
    await Bun.write(commentsFile, JSON.stringify(comments));
    print({ data: { minimizeComment: { minimizedComment: { isMinimized: true } } } });
  } else if (query.includes('node(id:')) {
    const comment = (await readComments()).find(entry => entry.id === field('id')) ?? fail('GraphQL: Could not resolve to a node with the global id.');
    print({ data: { viewer: actor, node: { author: comment.author ?? actor, repository: comment.repository ?? repo } } });
  } else if (query.includes('pullRequest(number:')) {
    const pull = findPull(field('number'));
    let connections;
    if (query.includes('comments(first:')) {
      const comments = (await readComments()).filter(comment => comment.number === pull.number);
      connections = { comments: page(comments.map(({ number, ...comment }) => ({ author: actor, isMinimized: false, ...comment }))) };
    } else if (query.includes('labels(first:')) {
      connections = { labels: page(pull.labels.map(name => ({ name }))) };
    } else {
      connections = { reviewRequests: page(pull.reviewRequests.map(reviewer => ({ requestedReviewer: { __typename: 'User', login: reviewer } }))) };
    }
    print({ data: { viewer: actor, repository: { ...repo, pullRequest: { number: pull.number, state: pull.state, headRefOid: pull.headRefOid, ...connections } } } });
  } else if (query.includes('requested:search')) {
    const requested = pulls.filter(pull => pull.state === 'OPEN' && (pull.teamReviewRequested || pull.reviewRequests.includes(login))).map(pull => ({ number: pull.number }));
    print({ data: { viewer: actor, requested: { ...page(requested), issueCount: requested.length } } });
  } else {
    print({ data: {
      viewer: actor,
      repository: { ...repo,
        pullRequests: page(pulls.filter(pull => pull.state === 'OPEN').map(listPull)) },
    } });
  }
} else if (command === 'api' && args.includes('POST')) {
  if (config.commentRejection) fail(config.commentRejection);
  const number = Number(/issues\/(\d+)\/comments/.exec(args.find(arg => arg.includes('/issues/')) ?? '')?.[1]);
  findPull(number);
  const comments = await readComments();
  const id = `comment-${comments.length + 1}`;
  const commentActor = config.commentAuthor ?? actor;
  const url = `https://git.example.invalid/${owner}/${repository}/pull/${number}#issuecomment-${comments.length + 1}`;
  comments.push({ id, url, number, body: await Bun.stdin.text(), author: commentActor });
  await Bun.write(commentsFile, JSON.stringify(comments));
  if (config.commentFailureAfterWrite) fail(config.commentFailureAfterWrite);
  if (config.commentResponse !== undefined) process.stdout.write(config.commentResponse);
  else print({ node_id: id, html_url: url, user: { node_id: commentActor.id, login: commentActor.login } });
} else if (command === 'api') {
  if (config.commentsFail) fail('HTTP 403: forbidden');
  const pages = config.commentPages ?? [[{ id: 1, path: 'example.txt', line: 1, side: 'RIGHT', body: 'synthetic comment' }]];
  if (args.includes('--slurp')) print(pages);
  else for (const page of pages) print(page);
} else if (action === 'view') {
  const { checks, labels, reviewRequests, teamReviewRequested, ...pull } = findPull(args[2]);
  print({ ...pull, statusCheckRollup: config.statusChecks ?? [] });
} else if (action === 'diff') console.log(config.diff ?? 'diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-initial\n+changed');
else process.exit(1);
