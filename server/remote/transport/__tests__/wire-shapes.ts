import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import type { JsonValue } from '@garcon/common/json';
import core from './fixtures/core-1-names.json';

// Expands aliases so an internal DTO edit cannot silently change a frozen wire shape.
// This is a test tripwire, not a serializer or evidence of runtime semantics.
export function coreWireShapes(): Record<string, JsonValue> {
  const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
  const configuration = ts.readConfigFile(`${root}/tsconfig.json`, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, root);
  const cli = `${root}/../cli/garcon-client.ts`;
  const program = ts.createProgram([`${root}/remote/transport/rpc.ts`, cli], parsed.options);
  const checker = program.getTypeChecker();
  const location = program.getSourceFile(`${root}/remote/transport/rpc-protocol.ts`)!;
  const shapes: Record<string, JsonValue> = {};
  const active = new Set<ts.Type>();

  const shape = (type: ts.Type): JsonValue => {
    if (active.has(type)) return { recursive: checker.typeToString(type) };
    active.add(type);
    try {
      if (type.isUnion()) return { union: type.types.map(shape).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
      if (type.isIntersection()) {
        const primitive = type.types.find(part => part.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike));
        if (primitive) return shape(primitive);
      }
      if (checker.isTupleType(type)) return { tuple: checker.getTypeArguments(type as ts.TypeReference).map(shape) };
      if (checker.isArrayType(type)) return { array: shape(checker.getTypeArguments(type as ts.TypeReference)[0]!) };
      if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) return checker.typeToString(type);
      if (type.getCallSignatures().length) throw new Error(`Non-wire callable: ${checker.typeToString(type)}`);
      const properties: Record<string, JsonValue> = {};
      for (const property of type.getProperties().sort((a, b) => a.name.localeCompare(b.name))) {
        const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? location;
        const member = checker.getTypeOfSymbolAtLocation(property, declaration);
        properties[`${property.name}${property.flags & ts.SymbolFlags.Optional ? '?' : ''}`] = shape(member);
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
  const rpc = exported(`${root}/remote/transport/rpc-protocol.ts`, 'ExecutorRpcMethods');
  for (const name of core.rpc) {
    const method = rpc.getProperty(name);
    if (!method) throw new Error(`Missing core RPC ${name}`);
    shapes[`rpc:${name}`] = shape(checker.getTypeOfSymbolAtLocation(method, method.declarations?.[0] ?? location));
  }
  const client = exported(cli, 'GarconClient');
  for (const method of client.getProperties().sort((a, b) => a.name.localeCompare(b.name))) {
    if (!method.valueDeclaration || method.name.includes('#')) continue;
    const signature = checker.getTypeOfSymbolAtLocation(method, method.valueDeclaration).getCallSignatures()[0];
    if (!signature) continue;
    shapes[`cli:${method.name}`] = {
      parameters: signature.parameters.filter(parameter => parameter.name !== 'signal').map(parameter => {
        const declaration = parameter.valueDeclaration!;
        return { name: parameter.name, type: shape(checker.getTypeOfSymbolAtLocation(parameter, declaration)) };
      }),
      result: shape(checker.getAwaitedType(signature.getReturnType())!),
    };
  }
  for (const [file, names] of [
    ['remote/transport/rpc-protocol.ts', ['AgentProducerFrame', 'ProducerAckFrame', 'ReplyAckFrame', 'ProducerResumeState']],
    ['remote/transport/terminal-protocol.ts', ['TerminalNotification']],
    ['remote/transport/rpc-lane.ts', ['BulkConnectionControl']],
  ] as const) {
    for (const name of names) shapes[name] = shape(exported(`${root}/${file}`, name));
  }
  const failure = program.getSourceFile(`${root}/remote/transport/rpc.ts`)!.statements.find(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === 'Failure');
  if (!failure) throw new Error('Missing RPC failure contract');
  shapes.Failure = shape(checker.getTypeAtLocation(failure));
  return shapes;
}
