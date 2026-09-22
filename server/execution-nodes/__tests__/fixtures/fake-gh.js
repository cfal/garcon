#!/usr/bin/env bun
const config = await Bun.file(`${process.cwd()}/gh-fixture.json`).json();
const [command, action] = process.argv.slice(2);
if (config.wait) {
  await Bun.write(`${process.cwd()}/gh-started`, 'ready');
  await new Promise(resolve => setTimeout(resolve, 60_000));
}
const pr = { number: 1, title: config.label, body: 'x'.repeat(config.bodyBytes ?? 0), state: 'OPEN',
  author: { login: config.label }, headRefName: 'feature', baseRefName: 'main', files: [{ path: 'example.txt', additions: 1, deletions: 1 }] };
if (command === 'auth') console.log(JSON.stringify({ hosts: { 'git.example.invalid': [{ active: true, state: 'success', login: config.label }] } }));
else if (command === 'repo') console.log(JSON.stringify({ nameWithOwner: `${config.label}/repository` }));
else if (command === 'api') {
  if (config.commentsFail) { console.error('HTTP 403: forbidden'); process.exit(1); }
  console.log(JSON.stringify([{ id: 1, path: 'example.txt', line: 1, side: 'RIGHT', body: 'synthetic comment' }]));
} else if (action === 'list') console.log(JSON.stringify([pr]));
else if (action === 'view') console.log(JSON.stringify(pr));
else if (action === 'diff') console.log('diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-initial\n+changed');
else process.exit(1);
