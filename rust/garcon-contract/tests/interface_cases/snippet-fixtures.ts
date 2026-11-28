import { runInNewContext } from 'node:vm';
import { matchSnippetTemplateTokens, normalizeSnippetDefinitionInput, normalizeSnippetsSnapshot } from '../../../../common/snippets.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

const templates = [
  '', '{{arguments}}', '{{chat_id}} {{current_date}} {{current_date_local}}',
  '\ud83d\ude00 \ud83d\ude00 {{project_path}}', '\\{{arguments}} \\\\{{project_path}} \\\\\\{{chat_id}}',
  '{{ current_date }} {{current_time}} {{{{arguments}}}}',
];

const inherited = Object.assign(Object.create({ shortName: 'review_api' }), {
  template: 'Synthetic {{arguments}}', defaultArguments: '',
});
const realmSnapshot = runInNewContext(`({
  revision: 1,
  snippets: [{ id: 'snippet-a', shortName: 'review_api', template: 'Synthetic {{arguments}}',
    defaultArguments: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
})`);
console.log(JSON.stringify({
  tokens: templates.map(template => [template, [...matchSnippetTemplateTokens(template)]]),
  inherited: [inherited, normalizeSnippetDefinitionInput(inherited)],
  crossRealm: [realmSnapshot, normalizeSnippetsSnapshot(realmSnapshot)],
}));
