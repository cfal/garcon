#!/usr/bin/env bun
const command = process.argv.at(-1);
const match = /^(git-upload-pack|git-receive-pack) '\/synthetic\/repository\.git'$/.exec(command ?? '');
if (!match || !process.env.WORKFLOW_TEST_REMOTE) throw new Error('Unexpected synthetic Git transport request.');
const child = Bun.spawn([match[1], process.env.WORKFLOW_TEST_REMOTE], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: process.env,
});
process.exit(await child.exited);
