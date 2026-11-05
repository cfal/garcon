#!/usr/bin/env bun
import { appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const root = process.env.WORKFLOW_TEST_REMOTE;
if (!root) throw new Error('Missing synthetic publication repository.');
await appendFile(`${root}/gh-calls.jsonl`, `${JSON.stringify(args)}\n`);
const repository = { nameWithOwner: 'synthetic/repository', url: 'https://git.example.invalid/synthetic/repository' };
const actor = { id: 'synthetic-actor', login: 'synthetic' };
const print = value => console.log(JSON.stringify(value));
async function head(name) {
  const child = Bun.spawn(['git', '-C', root, 'rev-parse', `refs/heads/${name}`], { stdout: 'pipe', stderr: 'pipe' });
  const value = (await new Response(child.stdout).text()).trim();
  if (await child.exited !== 0) throw new Error('Synthetic branch missing.');
  return value;
}
if (args[0] === 'repo') print(repository);
else if (args[0] === 'auth') print({ hosts: { 'git.example.invalid': [{ active: true, state: 'success', login: actor.login }] } });
else if (args[1] === 'graphql') print({ data: { viewer: actor } });
else if (args.some(arg => arg.includes('/git/ref/heads/'))) {
  print({ object: { sha: await head(decodeURIComponent(args.find(arg => arg.includes('/git/ref/heads/')).split('/git/ref/heads/')[1])) } });
} else if (args.some(arg => /\/pulls(?:\?|$)/.test(arg))) {
  const file = Bun.file(`${root}/publications.json`);
  const records = await file.exists() ? await file.json() : [];
  if (args.includes('POST')) {
    const input = JSON.parse(await Bun.stdin.text());
    const number = records.length + 1;
    const record = { number, title: input.title, body: input.body, draft: input.draft, state: 'open', merged_at: null,
      html_url: `${repository.url}/pull/${number}`, user: { node_id: actor.id, login: actor.login },
      head: { ref: input.head, sha: await head(input.head), repo: { full_name: repository.nameWithOwner } },
      base: { ref: input.base, sha: await head(input.base), repo: { full_name: repository.nameWithOwner } } };
    records.push(record);
    await Bun.write(file, JSON.stringify(records));
    print(record);
  } else print(records);
} else throw new Error('Unexpected synthetic GitHub request.');
