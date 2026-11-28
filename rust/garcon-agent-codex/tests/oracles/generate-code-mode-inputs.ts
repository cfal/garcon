const call = 'tools.exec_command({ cmd: "pwd" })';
const sources = new Set<string>();
const templateQuote = String.fromCharCode(96);
const templates = [
  'const result = await CALL;',
  'const result = await (CALL);',
  'const result = (await CALL);',
  'const result = await CALL\n',
  'const result = await /** synthetic */ CALL;',
];
const reporters = [
  '', ';', 'text(result);', '{ text(result.output); }',
  'if (result.exit_code !== undefined) text(String(result.exit_code)); else text("");',
  'text(JSON.stringify(result));', 'const out = result.output; text(out);',
  'text((result.output, result.exit_code));', 'text([, result.output]);',
  'text({ out: result?.output });', 'text(result?.output?.join(""));',
  'text(false ? "" : result.output);', 'text(!result.exit_code && result.output);',
  'text(typeof result.output);', 'text(delete result.output);',
  'text(result["output"]);', 'text(result.#output);',
  'text(Number("0"));', 'text(Boolean(result));', 'text([...result]);',
  'text({ [result]: "x" });', 'text({ ...result });',
  'const result = 2;', 'let result;', 'var result;',
  'const tools = {};', 'const { tools } = {};', 'const [, text] = [];',
  'const { nested: [Promise = 1] } = {};', 'const { ...tools } = {};',
  'const eval = 1;', 'const arguments = 1;', 'const await = 1;',
  'return result;', 'break;', 'continue;', 'with ({}) {}',
  'if (result) { const out = result.output; const out = ""; }',
  'for (const item of result) text(item);', 'for await (const item of result) text(item);',
  'for (let item of result) text(item);',
  'result.forEach(item => text(item));', 'result?.forEach(item => text(item));',
  'result.forEach(function(item) { text(item); });',
  'result.forEach(function(item, item) { text(item); });',
  'result.forEach(async item => { text(await item); });',
  'import value from "synthetic";', 'export { result };',
  'text(import("synthetic"));', 'text(new String("x"));',
  'text(/a[b]/gi);', 'text(/a/gg);', 'text(/[/);', 'text(/(?<x>a)\\k<x>/u);',
  'text(/(?<x>a)(?<x>b)/u);', 'text(/\\p{Letter}/u);',
  'text(/\\p{NotAProperty}/u);', 'text(/[[a]--[b]]/v);', 'text(/\\u{110000}/u);',
  'text(0xFFn);', 'text(010);', 'text(42_000);', 'text("\\1");',
];
for (const shape of templates) {
  for (const reporter of reporters) sources.add(shape.replace('CALL', call) + '\n' + reporter);
}

const callees = [
  'tools.exec_command', 'tools["exec_command"]', 'tools?.exec_command',
  'tools.exec_command?.', '(tools).exec_command', 't\\u006fols.exec_command',
  'tools.exec\\u005fcommand',
];
const inputs = [
  '{cmd:"pwd"}', '{"cmd":"pwd"}', '{["cmd"]:"pwd"}',
  '{cmd:' + templateQuote + 'pwd' + templateQuote + '}',
  '{cmd:' + templateQuote + 'pwd' + templateQuote + '}',
  '{cmd:""}', '{cmd: /pwd/u}', '{cmd:"pwd", extra: /x/}', '{cmd:"pwd", extra: /x/uu}',
  '{cmd:"pwd", cmd:"ls"}', '{cmd:"pwd", ...extra}',
  '{get cmd(){return "pwd"}}', '{cmd(){return "pwd"}}',
  '{cmd:"pwd", extra:[,]}', '{cmd:"pwd", extra:((1, 2))}',
  '{cmd:"pwd", extra:result?.path}', '{cmd:"pwd", extra:result?.path()}',
  '{cmd:"pwd", __proto__:null, __proto__:null}', '{cmd:"pwd", extra: 010}',
  '{cmd:"pwd"} as const', '{cmd:"pwd"}, {}', '...args',
];
for (const callee of callees) {
  for (const input of inputs) sources.add('const result = await ' + callee + '(' + input + ');');
}

const callbacks = [
  'cmd => tools.exec_command({cmd})',
  'async cmd => await tools.exec_command({cmd})',
  'async function(cmd) { return await tools.exec_command({cmd}); }',
  'async ([cmd, workdir]) => { const row = await tools.exec_command({cmd, workdir}); return row.output; }',
  '([cmd,]) => tools.exec_command({cmd})',
  '([,cmd]) => tools.exec_command({cmd})',
  '([cmd = "pwd"]) => tools.exec_command({cmd})',
  'entry => tools.exec_command({cmd: entry[0]})',
  'entry => tools.exec_command({cmd: entry[1]})',
  'entry => tools.exec_command({cmd: entry[1.2]})',
  'entry => tools.exec_command({cmd: entry?.[0]})',
  'tools => tools.exec_command({cmd:"pwd"})',
  '(cmd, cmd) => tools.exec_command({cmd})',
  'cmd => { if (cmd) return tools.exec_command({cmd}); }',
];
for (const list of [
  '["pwd", "ls"]', '[["pwd", "."], ["ls", "."]]', '[["pwd"], ["ls"]]',
  '[["pwd", "ls"], ["ls", "pwd"]]', '[null, false, 1]',
  '[["pwd"], ,["ls"]]', '[...args]', '[...[]]', '[]',
]) {
  for (const callback of callbacks) {
    sources.add('const entries = ' + list + '; const results = await Promise.all(entries.map(' +
      callback + ')); for (const row of results) text(row.output);');
  }
}

for (const args of [
  '[' + call + ', tools.exec_command({cmd: "ls"})]',
  '[' + call + ', await tools.exec_command({cmd: "ls"})]',
  '[' + call + ', , tools.exec_command({cmd: "ls"})]',
  '[' + call + ', ...other]',
  '[' + call + ']',
]) {
  for (const promise of ['Promise.all', 'Promise["all"]', 'Promise?.all', 'Promise.all?.', 'dummy.all']) {
    sources.add('const result = await ' + promise + '(' + args + '); result.forEach(row => text(row.output));');
  }
}
for (const n of [63, 64, 65]) {
  sources.add('const result = await Promise.all([' + Array(n).fill(call).join(',') + ']);');
}
sources.add('const result = await tools.exec_command({ cmd: "echo \\uD800" });');
sources.add('const result = await tools.exec_command({ cmd: ' + templateQuote + 'echo \\uD800' + templateQuote + ' });');
sources.add('const result = await tools.exec_command({ cmd: "echo \\uD83D\\uDE80" });');

for (const source of sources) {
  console.log(JSON.stringify({ fn: 'projectCodexCodeModeCommands', args: [source] }));
}
