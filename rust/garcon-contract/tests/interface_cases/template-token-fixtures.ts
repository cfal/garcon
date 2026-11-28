import { matchTemplateTokens, runtimeTemplateValues, RUNTIME_TEMPLATE_VARIABLES, TEMPLATE_VALIDATION_VALUES } from '../../../../common/template-tokens.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

const chatId = '1000000000000001';
const runtime = [
  '2030-01-01T00:30:00.000Z', '2028-02-29T23:30:00.000Z',
  '-000001-01-02T00:00:00.000Z', '+010000-01-02T00:00:00.000Z',
].map(instant => {
  const at = new Date(instant);
  return { chatId, at: at.getTime(), result: runtimeTemplateValues(chatId, at) };
});
const tokens = [
  { template: '{{chat_id}} \\{{project_path}} {{arguments}} {{ chat_id }}', allowed: ['chat_id', 'project_path'] },
  { template: '\ud83d\ude00{{unknown}}\ud83d\ude00\\\\{{chat_id}}\\{{current_date}}{{current_date_local}}', allowed: RUNTIME_TEMPLATE_VARIABLES },
  { template: '\n{{_ok2}}{{1bad}}{{UPPER}}{{}}{{no-dash}}', allowed: ['_ok2', '1bad', 'UPPER', 'no-dash'] },
  { template: '{{chat_id}}', allowed: [] },
].map(({ template, allowed }) => ({ template, allowed, result: [...matchTemplateTokens(template, allowed)] }));

console.log(JSON.stringify({ runtime, tokens, validation: TEMPLATE_VALIDATION_VALUES }));
