#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { readdirSync, watch } from 'node:fs';
import { appendFile } from 'node:fs/promises';
// Synthetic GitHub CLI. Reads `gh-fixture.json` from the working directory and
// keeps posted comments in `gh-comments.json` beside it so writes can be read back.
// A fingerprint batch names its repositories, so it finds each one's fixture in
// the working directory or the checkouts beneath it. With `GH_FAKE_METRICS`
// set, each invocation appends the GitHub requests it models and its stdout bytes.
const cwd = process.cwd();
const readFixture = async (directory) => {
  const file = Bun.file(`${directory}/gh-fixture.json`);
  return (await file.exists()) ? file.json() : {};
};
const config = await readFixture(cwd);
const args = process.argv.slice(2);
const [command, action] = args;
await appendFile(`${cwd}/gh-calls.jsonl`, `${JSON.stringify(args)}\n`);
let requests = 0;
// Output is written once at exit, since exiting before a large write drains would truncate it.
const output = [];
const write = (text) => { output.push(text); };
const finish = async (code) => {
  const stdout = output.join('');
  if (process.env.GH_FAKE_METRICS) {
    await appendFile(process.env.GH_FAKE_METRICS, `${JSON.stringify({ command: args.slice(0, 2).join(' '), requests, stdoutBytes: Buffer.byteLength(stdout), code })}\n`);
  }
  if (stdout) await Bun.write(Bun.stdout, stdout);
  process.exit(code);
};
if (config.wait) {
  await Bun.write(`${cwd}/gh-started`, 'ready');
  await new Promise(resolve => setTimeout(resolve, 60_000));
}
const describe = (fixture) => {
  const owner = fixture.owner ?? fixture.label;
  const repository = fixture.repository ?? 'repository';
  const login = fixture.login ?? fixture.label;
  const host = fixture.host ?? 'git.example.invalid';
  const defaultPull = { number: 1, title: fixture.label, author: { login: fixture.label } };
  return {
    owner, repository, login, host,
    actor: { id: fixture.viewerId ?? `actor:${login}`, login },
    repo: { nameWithOwner: `${owner}/${repository}`, url: `https://${host}/${owner}/${repository}` },
    pulls: (fixture.pulls ?? [defaultPull]).map(pull => ({
      title: `Pull request ${pull.number}`, body: 'x'.repeat(fixture.bodyBytes ?? 0), state: 'OPEN', isDraft: false,
      author: { login, __typename: 'User' }, authorAssociation: 'MEMBER', headRefName: 'feature', baseRefName: 'main',
      headRefOid: 'a'.repeat(40), baseRefOid: 'e'.repeat(40), isCrossRepository: false, additions: 1, deletions: 1, changedFiles: 1, reviewDecision: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', mergeable: 'MERGEABLE', reviewCount: 0, reviewThreadCount: 0,
      url: `https://git.example.invalid/${owner}/${repository}/pull/${pull.number}`,
      files: fixture.files ?? [{ path: 'example.txt', additions: 1, deletions: 1 }],
      labels: [], reviewRequests: [], checks: null, checkRunCounts: [],
      ...pull,
    })),
  };
};
const { owner, repository, login, host, actor, repo, pulls } = describe(config);
const defaultPull = { number: 1, title: config.label, author: { login: config.label } };
const commentsFile = `${cwd}/gh-comments.json`;
const readComments = async () => (await Bun.file(commentsFile).exists()) ? Bun.file(commentsFile).json() : (config.comments ?? []);
const field = (name) => {
  for (let index = 0; index < args.length - 1; index++) {
    if ((args[index] === '-f' || args[index] === '-F') && args[index + 1].startsWith(`${name}=`)) return args[index + 1].slice(name.length + 1);
  }
  return undefined;
};
const print = (value) => write(`${JSON.stringify(value)}\n`);
const fail = async (message) => { console.error(message); await finish(1); };
const findPull = async (number) => pulls.find(pull => pull.number === Number(number)) ?? await fail('GraphQL: Could not resolve to a PullRequest with the number.');

const page = (values, cursor = Number(field('endCursor') ?? 0), limit = config.pageSize ?? 100) => ({
  nodes: values.slice(cursor, cursor + limit),
  pageInfo: config.incompleteConnection ? null : { hasNextPage: cursor + limit < values.length, endCursor: String(cursor + limit) },
});
const fingerprintPull = ({ number, updatedAt, isDraft, headRefOid, baseRefOid, mergeable, reviewDecision, reviewCount, reviewThreadCount, checks, checkRunCounts }) => ({
  number, updatedAt, isDraft, headRefOid, baseRefOid, mergeable, reviewDecision,
  reviews: { totalCount: reviewCount }, reviewThreads: { totalCount: reviewThreadCount },
  commits: { nodes: [{ commit: { statusCheckRollup: checks ? { state: checks, contexts: { checkRunCountsByState: checkRunCounts, statusContextCountsByState: [] } } : null } }] },
});
// A list query that selects no fingerprint fields gets none, so payload sizes follow the query.
const listPull = (selectsFingerprint, selectsCheckCounts) => ({ files, body, labels, reviewRequests, checks, checkRunCounts, teamReviewRequested, reviewCount, reviewThreadCount, mergeable, ...pull }) => ({
  ...pull,
  ...(selectsFingerprint
    ? fingerprintPull({ ...pull, mergeable, checks, checkRunCounts: selectsCheckCounts ? checkRunCounts : [], reviewCount, reviewThreadCount })
    : { commits: { nodes: [{ commit: { statusCheckRollup: checks ? { state: checks } : null } }] } }),
  labels: page(labels.map(name => ({ name })), 0),
  reviewRequests: page(reviewRequests.map(reviewer => ({ requestedReviewer: { __typename: 'User', login: reviewer } })), 0),
});
const findFixture = async (nameWithOwner, directory = cwd, depth = 0) => {
  const fixture = await readFixture(directory);
  if (fixture.label && describe(fixture).repo.nameWithOwner === nameWithOwner) return fixture;
  if (depth >= 3) return null;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const found = await findFixture(nameWithOwner, `${directory}/${entry.name}`, depth + 1);
    if (found) return found;
  }
  return null;
};
const header = (status, headers = {}) => `HTTP/2.0 ${status}\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`;
const requestHeader = (name) => {
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === '-H' && args[index + 1].toLowerCase().startsWith(`${name.toLowerCase()}:`)) return args[index + 1].slice(name.length + 1).trim();
  }
  return undefined;
};

// Only a fingerprint batch, which names its repositories, runs without a fixture here.
const fingerprintBatch = command === 'api' && action === 'graphql' && (field('query') ?? '').includes('r0:repository(');
if (config.unsupportedCheckCounts && (field('query') ?? '').includes('checkRunCountsByState')) {
  await fail("GraphQL: Field 'checkRunCountsByState' doesn't exist on type 'StatusCheckRollupContextConnection'");
}
if (!config.label && !fingerprintBatch) await fail('gh: no synthetic fixture in this directory');
if (config.fail?.[`${command} ${action}`] || config.fail?.[command]) await fail(config.fail[`${command} ${action}`] ?? config.fail[command]);
if (command === 'auth' && action === 'token') {
  if (config.authTokenFails) await fail('no oauth token found');
  write(`${config.token ?? `token-${login}`}\n`);
} else if (command === 'auth') { requests = 1; print({ hosts: { [host]: [{ active: true, state: 'success', login }] } }); }
else if (command === 'repo') { requests = 1; print(repo); }
else if (fingerprintBatch) {
  requests = 1;
  if (config.fingerprintFailure) await fail(config.fingerprintFailure);
  // The account is gh's own; without a fixture here it is the first repository's.
  const data = { viewer: config.label ? actor : null };
  const errors = [];
  for (let index = 0; field(`o${index}`) !== undefined; index++) {
    const alias = `r${index}`;
    const nameWithOwner = `${field(`o${index}`)}/${field(`n${index}`)}`;
    const fixture = await findFixture(nameWithOwner);
    if (!fixture || fixture.fingerprintError) {
      data[alias] = null;
      errors.push({ type: fixture?.fingerprintError ?? 'NOT_FOUND', path: [alias], message: `Could not resolve to a Repository with the name '${nameWithOwner}'.` });
      continue;
    }
    const described = describe(fixture);
    data.viewer ??= described.actor;
    const open = described.pulls.filter(pull => pull.state === 'OPEN');
    data[alias] = { ...described.repo, pullRequests: { pageInfo: { hasNextPage: open.length > 100 }, nodes: open.slice(0, 100).map(fingerprintPull) } };
  }
  print(errors.length ? { data, errors } : { data });
  if (errors.length) await fail(`gh: ${errors.map(error => error.message).join('\n')}`);
}
else if (command === 'api' && action === 'graphql') {
  requests = 1;
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
    const comment = comments.find(entry => entry.id === field('id')) ?? await fail('GraphQL: Could not resolve to a node with the global id.');
    comment.isMinimized = true;
    await Bun.write(commentsFile, JSON.stringify(comments));
    print({ data: { minimizeComment: { minimizedComment: { isMinimized: true } } } });
  } else if (query.includes('node(id:')) {
    const comment = (await readComments()).find(entry => entry.id === field('id')) ?? await fail('GraphQL: Could not resolve to a node with the global id.');
    print({ data: { viewer: actor, node: { author: comment.author ?? actor, repository: comment.repository ?? repo } } });
  } else if (query.includes('pullRequest(number:')) {
    const pull = await findPull(field('number'));
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
        pullRequests: page(pulls.filter(pull => pull.state === 'OPEN').map(listPull(query.includes('reviewThreads'), query.includes('checkRunCountsByState')))) },
    } });
  }
} else if (command === 'api' && args.includes('POST')) {
  requests = 1;
  if (config.commentRejection) await fail(config.commentRejection);
  const number = Number(/issues\/(\d+)\/comments/.exec(args.find(arg => arg.includes('/issues/')) ?? '')?.[1]);
  await findPull(number);
  const comments = await readComments();
  const id = `comment-${comments.length + 1}`;
  const commentActor = config.commentAuthor ?? actor;
  const url = `https://git.example.invalid/${owner}/${repository}/pull/${number}#issuecomment-${comments.length + 1}`;
  comments.push({ id, url, number, body: await Bun.stdin.text(), author: commentActor });
  await Bun.write(commentsFile, JSON.stringify(comments));
  if (config.commentFailureAfterWrite) await fail(config.commentFailureAfterWrite);
  if (config.commentResponse !== undefined) write(config.commentResponse);
  else print({ node_id: id, html_url: url, user: { node_id: commentActor.id, login: commentActor.login } });
} else if (command === 'api' && args.some(arg => arg.includes('/compare/'))) {
  const comparison = args.find(arg => arg.includes('/compare/')).split('/compare/')[1];
  if (config.holdCompare) {
    const released = Promise.withResolvers();
    const watcher = watch(cwd, (_event, filename) => { if (filename === 'gh-compare-release') released.resolve(); });
    try {
      await Bun.write(`${cwd}/gh-compare-started`, 'ready');
      if (!await Bun.file(`${cwd}/gh-compare-release`).exists()) await released.promise;
    } finally { watcher.close(); }
  }
  if (config.pushDuringDiff) {
    const { pushDuringDiff, ...rest } = config;
    await Bun.write(`${cwd}/gh-fixture.json`, JSON.stringify({ ...rest, pulls: (config.pulls ?? [defaultPull]).map(pull => ({ ...pull, ...pushDuringDiff })) }));
  }
  console.log(config.comparisons?.[comparison] ?? config.diff ?? 'diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-initial\n+changed');
} else if (command === 'api' && args.includes('--include')) {
  // Pages a REST listing with ETags; a matching If-None-Match is answered 304, and gh exits 1 after printing it.
  requests = 1;
  if (config.expectedRestToken && (process.env.GH_TOKEN !== config.expectedRestToken || process.env.GH_ENTERPRISE_TOKEN !== config.expectedRestToken))
    await fail('Conditional request did not use its captured credential.');
  if (config.commentsFail) {
    write(header('403 Forbidden', { 'Content-Type': 'application/json; charset=utf-8' }));
    print({ message: 'forbidden' });
    await fail('gh: forbidden (HTTP 403)');
  }
  if (config.pushDuringComments) {
    const { pushDuringComments, ...rest } = config;
    await Bun.write(`${cwd}/gh-fixture.json`, JSON.stringify({ ...rest, pulls: (config.pulls ?? [defaultPull]).map(pull => ({ ...pull, ...pushDuringComments })) }));
  }
  const pages = config.commentPages ?? [[{ id: 1, path: 'example.txt', line: 1, side: 'RIGHT', body: 'synthetic comment' }]];
  const path = args[args.length - 1];
  const number = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
  const body = `${JSON.stringify(pages[number - 1] ?? [])}\n`;
  const etag = `W/"${createHash('sha1').update(body).digest('hex')}"`;
  const headers = { Etag: etag, ...(number < pages.length ? { Link: `<https://api.example.invalid/${path.replace(/page=\d+/, `page=${number + 1}`)}>; rel="next"` } : {}) };
  if (requestHeader('If-None-Match') === etag) {
    write(header('304 Not Modified', headers));
    await fail('gh: HTTP 304');
  }
  write(header('200 OK', { 'Content-Type': 'application/json; charset=utf-8', ...headers }));
  write(body);
} else if (command === 'api') {
  if (config.commentsFail) await fail('HTTP 403: forbidden');
  const pages = config.commentPages ?? [[{ id: 1, path: 'example.txt', line: 1, side: 'RIGHT', body: 'synthetic comment' }]];
  requests = pages.length;
  if (args.includes('--slurp')) print(pages);
  else for (const page of pages) print(page);
} else if (action === 'view') {
  if (config.holdStatus) {
    const released = Promise.withResolvers();
    const watcher = watch(cwd, (_event, filename) => { if (filename === 'gh-status-release') released.resolve(); });
    try {
      await Bun.write(`${cwd}/gh-status-started`, 'ready');
      if (!await Bun.file(`${cwd}/gh-status-release`).exists()) await released.promise;
    } finally { watcher.close(); }
  }
  requests = 1;
  const { checks, checkRunCounts, labels, reviewRequests, teamReviewRequested, reviewCount, reviewThreadCount, ...pull } = await findPull(args[2]);
  print({ ...pull, statusCheckRollup: config.statusChecks ?? [] });
} else if (action === 'diff') {
  requests = 2;
  // Simulates a push that lands while the diff is being read.
  if (config.pushDuringDiff) {
    const { pushDuringDiff, ...rest } = config;
    await Bun.write(`${cwd}/gh-fixture.json`, JSON.stringify({ ...rest, pulls: (config.pulls ?? [defaultPull]).map(pull => ({ ...pull, ...pushDuringDiff })) }));
  }
  write(`${config.diff ?? 'diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-initial\n+changed'}\n`);
}
else await finish(1);
await finish(0);
