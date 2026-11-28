import { ticketQueryParams, ticketSearchParams } from '../../../../common/ticket-query.ts';

const samples = {
  project: 'a + b / Caf\u00e9',
  status: 'in-review',
  includeClosed: false,
  priority: 0,
  label: '%bug?&=*~',
  ready: true,
  query: ' \u6c34\u{1f600}\n ',
  beforeNumber: 100,
  expectedCollectionRevision: 0,
  limit: 50,
  ticketId: 'G-2',
  includeDescription: false,
  commentLimit: 0,
  beforeCommentSequence: 55,
  beforeSequence: 70,
};

const fields = Object.entries(samples);
const assignees = [
  { kind: 'executor', executorId: 'local' },
  { kind: 'chat', chatId: '1000000000000001' },
  { kind: 'user', ownerKey: 'user:A+B\u00a0Caf\u00e9' },
  'unassigned',
] as const;

const searchQueries = [
  {},
  ...fields.map(([key, value]) => ({ [key]: value })),
  ...assignees.map((assignee) => ({ assignee })),
  { project: '', query: '', label: '' },
  { project: 'same', query: 'same', label: 'same' },
  ...assignees.flatMap((assignee) => [
    { ...samples, assignee },
    { assignee, ...Object.fromEntries(fields.toReversed()) },
  ]),
];

for (const query of searchQueries) {
  const result = ticketSearchParams(query as Parameters<typeof ticketSearchParams>[0]);
  console.log(JSON.stringify({ kind: 'search', query, pairs: [...result], text: String(result) }));
}

const parseQueries = [
  '',
  '?',
  '&&',
  'query',
  '?query=raw+plus%2Bliteral%20space',
  'label=%E6%B0%B4%F0%9F%98%80&project=%C3%A9',
  'query=%&label=%FF&project=%E2%82',
  'query=first=tail&label=%26&project=space+',
  'z=a&10=b&2=c&__proto__=safe&constructor=own&toString=value',
  'unexpected=&extra',
  'ready=1',
  'includeClosed=True',
  'includeDescription=',
  'assignee=',
  'assignee=other%3Aname',
  'limit=01',
  'limit=-1',
  'limit=1.25',
  'limit=9007199254740993',
  'limit=1000000000000000000000',
  `limit=${'9'.repeat(400)}`,
  ...fields.flatMap(([key, value]) => {
    const single = String(new URLSearchParams([[key, String(value)]]));
    return [single, `${single}&${single}`, `${key}=`];
  }),
  'query=first&qu%65ry=second',
  'limit=10&limit=20',
  'project=same&query=same&label=same',
  ...assignees.flatMap((assignee) => {
    const encoded = ticketSearchParams({ assignee });
    const allFields = fields.map(([key, value]) => [key, String(value)]);
    return [
      String(encoded),
      String(new URLSearchParams([...allFields, ...encoded])),
      String(new URLSearchParams([...encoded, ...allFields.toReversed()])),
    ];
  }),
];

for (const query of parseQueries) {
  try {
    const result = ticketQueryParams(new URLSearchParams(query));
    console.log(JSON.stringify({ kind: 'parse', query, pairs: Object.entries(result), text: JSON.stringify(result) }));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.log(JSON.stringify({ kind: 'parse', query, error: { name: error.name, message: error.message } }));
  }
}
