import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import type { JsonValue } from '@garcon/common/json';
import { CLI_OPERATIONS } from '@garcon/common/cli-contracts';
import { RPC_V1, PRODUCER_EVENTS_V1, TERMINAL_EVENTS_V1, PRODUCER_BINDING_V1, TERMINAL_ATTACHMENT_V1, HISTORY_READER_V1 } from '@garcon/common/executor-contracts';
import { contractKey } from '@garcon/common/protocol-contracts';
import { RENDERED_MESSAGES_V1 } from '../producer-protocol.js';

const CLI_CLIENTS = {
  'cli.schedules.list': 'getScheduledPrompts',
  'cli.schedules.create': 'createScheduledPrompt',
  'cli.schedules.update': 'updateScheduledPrompt',
  'cli.schedules.delete': 'deleteScheduledPrompt',
  'cli.schedules.enabled': 'setScheduledPromptEnabled',
  'cli.executors.list': 'listExecutors',
  'cli.executors.create': 'createExecutor',
  'cli.executors.update': 'updateExecutor',
  'cli.executors.delete': 'deleteExecutor',
  'cli.executors.connection': 'getExecutorConnection',
  'cli.providers.assignments': 'getExecutorProviders',
  'cli.providers.assign': 'assignExecutorProvider',
  'cli.providers.unassign': 'unassignExecutorProvider',
  'cli.models.list': 'getModelCatalog',
  'cli.settings.read': 'getSettings',
  'cli.preambles.list': 'getPreambles',
  'cli.chats.list': 'listChats',
  'cli.chats.messages': 'getChatMessages',
  'cli.chats.snapshot': 'getChatSnapshot',
  'cli.chats.turnReceipt': 'getTurnReceipt',
  'cli.chats.export': 'getTranscriptExport',
  'cli.chats.handoffArtifact': 'getChatHandoffArtifact',
  'cli.chats.lookupNativeSession': 'lookupNativeSession',
  'cli.chats.search': 'searchChats',
  'cli.chats.searchStatus': 'getTranscriptSearchStatus',
  'cli.chats.rebuildSearch': 'rebuildTranscriptSearch',
  'cli.settings.updateSearch': 'setTranscriptSearchEnabled',
  'cli.chats.start': 'startChat',
  'cli.chats.run': 'runChat',
  'cli.chats.fork': 'forkChat',
  'cli.chats.forkRun': 'forkRun',
  'cli.chats.steer': 'steerChat',
  'cli.chats.stop': 'stopChat',
  'cli.chats.permissionDecision': 'decidePermission',
  'cli.chats.rows': 'getChatRowTarget',
  'cli.chats.addRow': 'addChatRow',
  'cli.chats.rename': 'updateChatTitle',
  'cli.chats.pin': 'setChatPinned',
  'cli.chats.archive': 'setChatArchived',
  'cli.chats.tags': 'setChatTags',
  'cli.chats.setTags': 'setChatTags',
  'cli.tickets.bootstrap': 'getTicketBootstrap',
  'cli.tickets.list': 'listTickets',
  'cli.tickets.detail': 'readTicket',
  'cli.tickets.history': 'getTicketHistory',
  'cli.tickets.projectDefault': 'getTicketProjectDefault',
  'cli.tickets.mutate': 'mutateTicket',
} as const;

// Expands aliases so an internal DTO edit cannot silently change a frozen wire shape.
// This is a test tripwire, not a serializer or evidence of runtime semantics.
export function contractWireShapes(): {
  readonly contracts: Record<string, JsonValue>;
  readonly bootstrap: Record<string, JsonValue>;
  readonly cliBootstrap: Record<string, JsonValue>;
} {
  const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
  const configuration = ts.readConfigFile(`${root}/tsconfig.json`, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, root);
  const cli = `${root}/../cli/garcon-client.ts`;
  const program = ts.createProgram([`${root}/remote/transport/rpc.ts`, `${root}/remote/transport/link-handshake.ts`, cli], parsed.options);
  const checker = program.getTypeChecker();
  const location = program.getSourceFile(`${root}/remote/transport/rpc-protocol.ts`)!;
  const contracts: Record<string, JsonValue> = {};
  const active = new Set<ts.Type>();

  const shape = (type: ts.Type, opaque: Readonly<Record<string, JsonValue>> = {}): JsonValue => {
    if (active.has(type)) return { recursive: checker.typeToString(type) };
    active.add(type);
    try {
      if (type.isUnion()) return { union: type.types.map(item => shape(item)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
      if (type.isIntersection()) {
        const primitive = type.types.find(part => part.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike));
        if (primitive) return shape(primitive);
      }
      if (checker.isTupleType(type)) return { tuple: checker.getTypeArguments(type as ts.TypeReference).map(item => shape(item)) };
      if (checker.isArrayType(type)) return { array: shape(checker.getTypeArguments(type as ts.TypeReference)[0]!) };
      if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) return checker.typeToString(type);
      if (type.getCallSignatures().length) throw new Error(`Non-wire callable: ${checker.typeToString(type)}`);
      const properties: Record<string, JsonValue> = {};
      for (const property of type.getProperties().sort((a, b) => a.name.localeCompare(b.name))) {
        const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? location;
        const member = checker.getTypeOfSymbolAtLocation(property, declaration);
        properties[`${property.name}${property.flags & ts.SymbolFlags.Optional ? '?' : ''}`] = opaque[property.name] ?? shape(member);
      }
      const index = type.getStringIndexType();
      if (index) properties['[string]'] = shape(index);
      return properties;
    } finally { active.delete(type); }
  };

  const exported = (file: string, name: string) => {
    const source = program.getSourceFile(file);
    const symbol = source && checker.getSymbolAtLocation(source);
    const declaration = symbol && checker.getExportsOfModule(symbol).find(item => item.name === name);
    if (!declaration) throw new Error(`Missing contract ${name} in ${file}`);
    return checker.getDeclaredTypeOfSymbol(declaration);
  };
  const member = (type: ts.Type, name: string) => {
    const property = type.getProperty(name);
    if (!property) throw new Error(`Missing wire member ${name}`);
    return checker.getTypeOfSymbolAtLocation(property, property.declarations?.[0] ?? location);
  };
  const rpc = exported(`${root}/remote/transport/rpc-protocol.ts`, 'ExecutorRpcVersions');
  for (const definition of Object.values(RPC_V1)) contracts[contractKey(definition)] = {
    definition, wire: shape(member(member(rpc, definition.name), String(definition.version))), failures: 'rpc-errors-v1',
  };
  const client = exported(cli, 'GarconClient');
  const clientShapes: Record<string, JsonValue> = {};
  for (const method of client.getProperties().sort((a, b) => a.name.localeCompare(b.name))) {
    if (!method.valueDeclaration || method.name.includes('#')) continue;
    const signature = checker.getTypeOfSymbolAtLocation(method, method.valueDeclaration).getCallSignatures()[0];
    if (!signature) continue;
    clientShapes[method.name] = {
      parameters: signature.parameters.filter(parameter => parameter.name !== 'signal').map(parameter => {
        const declaration = parameter.valueDeclaration!;
        return { name: parameter.name, type: shape(checker.getTypeOfSymbolAtLocation(parameter, declaration)) };
      }),
      result: shape(checker.getAwaitedType(signature.getReturnType())!),
    };
  }
  const usedClients = new Set<string>(['verifyRuntime']);
  for (const [route, versions] of Object.entries(CLI_OPERATIONS)) for (const definition of Object.values(versions)) {
    const method = CLI_CLIENTS[definition.name];
    if (!clientShapes[method]) throw new Error(`Missing CLI client ${method}`);
    usedClients.add(method);
    contracts[contractKey(definition)] = { definition, route, client: clientShapes[method]! };
  }
  for (const name of Object.keys(clientShapes)) if (!usedClients.has(name)) throw new Error(`Unclassified CLI client ${name}`);
  const variantShape = (union: ts.Type, kind: string): JsonValue => {
    const types = (union.isUnion() ? union.types : [union]).filter(type => {
      const discriminant = member(type, 'type');
      return (discriminant.isUnion() ? discriminant.types : [discriminant])
        .some(value => value.isStringLiteral() && value.value === kind);
    });
    if (!types.length) throw new Error(`Missing event ${kind}`);
    const shapes = types.map(type => shape(type, { type: JSON.stringify(kind) }));
    return shapes.length === 1 ? shapes[0]! : { union: shapes.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
  };
  const producer = member(exported(`${root}/../server-agents/interface/src/contracts/producer.ts`, 'AgentProducerNotification'), 'event');
  for (const [kind, definition] of Object.entries(PRODUCER_EVENTS_V1)) contracts[contractKey(definition)] = {
    definition, wire: variantShape(producer, kind),
    ...(kind === 'rows' ? { messages: Object.keys(RENDERED_MESSAGES_V1).sort() } : {}),
  };
  const terminal = exported(`${root}/../common/terminal.ts`, 'TerminalStreamServerMessage');
  for (const [kind, definition] of Object.entries(TERMINAL_EVENTS_V1)) contracts[contractKey(definition)] = {
    definition, wire: variantShape(terminal, kind),
  };
  contracts[contractKey(PRODUCER_BINDING_V1)] = { definition: PRODUCER_BINDING_V1,
    frame: shape(exported(`${root}/remote/transport/rpc-protocol.ts`, 'AgentProducerFrame'), { notification: 'unknown' }),
    notification: shape(exported(`${root}/../server-agents/interface/src/contracts/producer.ts`, 'AgentProducerNotification'), { event: 'unknown' }),
    acknowledgements: shape(exported(`${root}/remote/transport/rpc-protocol.ts`, 'ProducerAckFrame')),
    resume: shape(exported(`${root}/remote/transport/rpc-protocol.ts`, 'ProducerResumeState')),
  };
  contracts[contractKey(TERMINAL_ATTACHMENT_V1)] = { definition: TERMINAL_ATTACHMENT_V1,
    notification: shape(exported(`${root}/remote/transport/terminal-protocol.ts`, 'TerminalNotification'), { message: 'unknown' }) };
  contracts[contractKey(HISTORY_READER_V1)] = { definition: HISTORY_READER_V1,
    reference: shape(exported(`${root}/remote/transport/rpc-protocol.ts`, 'HistoryReaderRef')) };
  const frame = program.getSourceFile(`${root}/remote/transport/rpc.ts`)!.statements.find(statement => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'RpcFrame');
  if (!frame) throw new Error('Missing RPC frame contract');
  const frameType = checker.getTypeAtLocation(frame);
  if (!frameType.isUnion()) throw new Error('Missing RPC routing union');
  const envelopes = new Set(frameType.types.map(type => JSON.stringify(shape(type, {
    method: 'string', version: 'number', request: 'unknown', value: 'unknown', error: 'unknown', notification: 'unknown', message: 'unknown',
  }))));
  return { contracts, bootstrap: {
    hello: shape(exported(`${root}/remote/transport/link-handshake.ts`, 'LinkHello')),
    proof: shape(exported(`${root}/remote/transport/link-handshake.ts`, 'LinkProof')),
    frames: [...envelopes].sort().map(value => JSON.parse(value)),
    failure: shape(exported(`${root}/remote/transport/rpc-failure.ts`, 'Failure'), { code: 'string' }),
  }, cliBootstrap: {
    context: shape(exported(`${root}/../common/server-runtime.ts`, 'CliContext')),
    verifyRuntime: clientShapes.verifyRuntime!,
  } };
}
