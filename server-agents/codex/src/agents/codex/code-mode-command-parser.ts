import {
  parse,
  type AnyNode,
  type ArrowFunctionExpression,
  type CallExpression,
  type Expression,
  type FunctionExpression,
  type Pattern,
  type Program,
  type Statement,
  type VariableDeclaration,
} from 'acorn';
import {
  isDataExpression,
  isPureReporterExpression,
  propertyName,
  resolveStaticString,
  staticValue,
  type StaticBindings,
  type StaticValue,
} from './code-mode-command-expressions.js';

const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_COMMANDS = 64;

type CallbackExpression = ArrowFunctionExpression | FunctionExpression;

interface RecognizedProgram {
  readonly commands: string[];
  readonly consumedStatements: ReadonlySet<Statement>;
  readonly resultBinding: string;
}

export interface CodexCodeModeCommandProjection {
  readonly commands: readonly string[];
}

/** Parses a bounded Code Mode program without evaluating it. */
export function projectCodexCodeModeCommands(
  source: string,
): CodexCodeModeCommandProjection | null {
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) return null;

  let program: Program;
  try {
    program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return null;
  }
  if (hasReservedTopLevelBinding(program)) return null;

  const recognizers = [recognizeDirectCommand, recognizeLiteralBatch, recognizeMappedBatch];
  for (const recognize of recognizers) {
    const recognized = recognize(program);
    if (!recognized) continue;
    if (
      recognized.commands.length === 0
      || recognized.commands.length > MAX_COMMANDS
      || recognized.commands.some((command) => command.length === 0)
    ) return null;
    if (!validateRemainingProgram(program, recognized)) return null;
    return { commands: recognized.commands };
  }

  return null;
}

function recognizeDirectCommand(program: Program): RecognizedProgram | null {
  const matches: RecognizedProgram[] = [];
  for (const statement of program.body) {
    const declaration = singleConstDeclaration(statement);
    if (!declaration || declaration.declarations[0].id.type !== 'Identifier') continue;
    const call = awaitedCall(declaration.declarations[0].init);
    if (!call || !isToolsExecCommandCall(call)) continue;
    const command = extractExecCommand(call, new Map());
    if (command === null) return null;
    matches.push({
      commands: [command],
      consumedStatements: new Set([declaration]),
      resultBinding: declaration.declarations[0].id.name,
    });
  }
  return matches.length === 1 ? matches[0] : null;
}

function recognizeLiteralBatch(program: Program): RecognizedProgram | null {
  const matches: RecognizedProgram[] = [];
  for (const statement of program.body) {
    const declaration = singleConstDeclaration(statement);
    if (!declaration || declaration.declarations[0].id.type !== 'Identifier') continue;
    const promiseInput = awaitedPromiseAllInput(declaration.declarations[0].init);
    if (!promiseInput || promiseInput.type !== 'ArrayExpression') continue;

    const commands: string[] = [];
    for (const element of promiseInput.elements) {
      if (!element || element.type === 'SpreadElement') return null;
      const call = unwrapCall(element);
      if (!call || !isToolsExecCommandCall(call)) return null;
      const command = extractExecCommand(call, new Map());
      if (command === null) return null;
      commands.push(command);
    }
    matches.push({
      commands,
      consumedStatements: new Set([declaration]),
      resultBinding: declaration.declarations[0].id.name,
    });
  }
  return matches.length === 1 ? matches[0] : null;
}

function recognizeMappedBatch(program: Program): RecognizedProgram | null {
  const declarations = topLevelConstArrays(program);
  const matches: RecognizedProgram[] = [];

  for (const statement of program.body) {
    const resultDeclaration = singleConstDeclaration(statement);
    if (!resultDeclaration || resultDeclaration.declarations[0].id.type !== 'Identifier') continue;
    const promiseInput = awaitedPromiseAllInput(resultDeclaration.declarations[0].init);
    const map = promiseInput && mappedCallback(promiseInput);
    if (!map) continue;

    const commandDeclaration = declarations.get(map.sourceName);
    if (!commandDeclaration) return null;
    const callbackExec = unconditionalCallbackExec(map.callback);
    if (!callbackExec) return null;

    const commands: string[] = [];
    for (const item of commandDeclaration.values) {
      const bindings = bindStaticPattern(map.callback.params[0], item);
      if (!bindings) return null;
      const command = extractExecCommand(callbackExec, bindings);
      if (command === null) return null;
      commands.push(command);
    }

    matches.push({
      commands,
      consumedStatements: new Set([commandDeclaration.statement, resultDeclaration]),
      resultBinding: resultDeclaration.declarations[0].id.name,
    });
  }

  return matches.length === 1 ? matches[0] : null;
}

function validateRemainingProgram(program: Program, recognized: RecognizedProgram): boolean {
  return program.body.every((statement) => (
    statement.type !== 'ImportDeclaration'
    && statement.type !== 'ExportNamedDeclaration'
    && statement.type !== 'ExportDefaultDeclaration'
    && statement.type !== 'ExportAllDeclaration'
    && (
      recognized.consumedStatements.has(statement)
      || isReporterStatement(statement, new Set([recognized.resultBinding]))
    )
  ));
}

function isReporterStatement(statement: Statement, resultBindings: ReadonlySet<string>): boolean {
  switch (statement.type) {
    case 'EmptyStatement':
      return true;
    case 'BlockStatement':
      return statement.body.every((child) => isReporterStatement(child, resultBindings));
    case 'ExpressionStatement':
      return isTextCall(statement.expression)
        || isResultForEachCall(statement.expression, resultBindings);
    case 'VariableDeclaration':
      return statement.kind === 'const'
        && statement.declarations.every((declaration) => (
          declaration.id.type === 'Identifier'
          && !isReservedBinding(declaration.id.name)
          && Boolean(declaration.init)
          && isPureReporterExpression(declaration.init!)
        ));
    case 'IfStatement':
      return isPureReporterExpression(statement.test)
        && isReporterStatement(statement.consequent, resultBindings)
        && (!statement.alternate || isReporterStatement(statement.alternate, resultBindings));
    case 'ForOfStatement':
      return !statement.await
        && isSingleIdentifierConst(statement.left)
        && isResultBindingExpression(statement.right, resultBindings)
        && isReporterStatement(statement.body, resultBindings);
    default:
      return false;
  }
}

function isResultForEachCall(
  expression: Expression,
  resultBindings: ReadonlySet<string>,
): boolean {
  if (expression.type !== 'CallExpression' || expression.arguments.length !== 1) return false;
  if (!isMemberCall(expression, 'forEach')) return false;
  if (expression.callee.object.type === 'Super') return false;
  if (!isResultBindingExpression(expression.callee.object, resultBindings)) return false;
  const callback = expression.arguments[0];
  if (!isCallback(callback)) return false;
  if (callback.body.type === 'BlockStatement') {
    return callback.body.body.every((statement) => isReporterStatement(statement, resultBindings));
  }
  return isTextCall(callback.body);
}

function isTextCall(expression: Expression): boolean {
  return expression.type === 'CallExpression'
    && expression.callee.type === 'Identifier'
    && expression.callee.name === 'text'
    && expression.arguments.every((argument) => (
      argument.type !== 'SpreadElement' && isPureReporterExpression(argument)
    ));
}

function extractExecCommand(call: CallExpression, bindings: StaticBindings): string | null {
  if (call.arguments.length !== 1) return null;
  const argument = call.arguments[0];
  if (argument.type !== 'ObjectExpression') return null;

  let command: string | null = null;
  let commandProperties = 0;
  for (const property of argument.properties) {
    if (
      property.type !== 'Property'
      || property.kind !== 'init'
      || property.method
      || property.computed
      || !isDataExpression(property.value)
    ) return null;
    if (propertyName(property.key) !== 'cmd') continue;
    commandProperties += 1;
    command = resolveStaticString(property.value, bindings);
  }

  return commandProperties === 1 ? command : null;
}

function unconditionalCallbackExec(callback: CallbackExpression): CallExpression | null {
  if (callback.params.length !== 1) return null;
  if (patternBindsReserved(callback.params[0])) return null;
  if (callback.body.type !== 'BlockStatement') {
    const call = unwrapCall(callback.body);
    return call && isToolsExecCommandCall(call) ? call : null;
  }

  let execCall: CallExpression | null = null;
  for (const statement of callback.body.body) {
    const candidate = callbackExecStatement(statement);
    if (candidate) {
      if (execCall) return null;
      execCall = candidate;
      continue;
    }
    if (!isCallbackLocalStatement(statement)) return null;
  }
  return execCall;
}

function callbackExecStatement(statement: Statement): CallExpression | null {
  if (statement.type === 'ReturnStatement' && statement.argument) {
    const call = unwrapCall(statement.argument);
    return call && isToolsExecCommandCall(call) ? call : null;
  }
  const declaration = singleConstDeclaration(statement);
  if (!declaration || declaration.declarations[0].id.type !== 'Identifier') return null;
  const call = unwrapCall(declaration.declarations[0].init);
  return call && isToolsExecCommandCall(call) ? call : null;
}

function isCallbackLocalStatement(statement: Statement): boolean {
  if (statement.type === 'EmptyStatement') return true;
  if (statement.type === 'ReturnStatement') {
    return !statement.argument || isPureReporterExpression(statement.argument);
  }
  if (statement.type === 'VariableDeclaration') {
    return statement.kind === 'const'
      && statement.declarations.every((declaration) => (
        declaration.id.type === 'Identifier'
        && !isReservedBinding(declaration.id.name)
        && Boolean(declaration.init)
        && isPureReporterExpression(declaration.init!)
      ));
  }
  return false;
}

function topLevelConstArrays(program: Program): Map<string, {
  readonly statement: Statement;
  readonly values: readonly StaticValue[];
}> {
  const arrays = new Map<string, { statement: Statement; values: readonly StaticValue[] }>();
  for (const statement of program.body) {
    const declaration = singleConstDeclaration(statement);
    if (!declaration) continue;
    const declarator = declaration.declarations[0];
    if (declarator.id.type !== 'Identifier' || declarator.init?.type !== 'ArrayExpression') continue;
    const values = declarator.init.elements.map((element) => (
      element && element.type !== 'SpreadElement' ? staticValue(element) : undefined
    ));
    if (values.some((value) => value === undefined)) continue;
    arrays.set(declarator.id.name, { statement: declaration, values: values as StaticValue[] });
  }
  return arrays;
}

function bindStaticPattern(pattern: Pattern, value: StaticValue): StaticBindings | null {
  const bindings = new Map<string, StaticValue>();
  if (pattern.type === 'Identifier') {
    bindings.set(pattern.name, value);
    return bindings;
  }
  if (pattern.type !== 'ArrayPattern' || !Array.isArray(value)) return null;
  for (let index = 0; index < pattern.elements.length; index += 1) {
    const element = pattern.elements[index];
    if (element === null) continue;
    if (element.type !== 'Identifier' || index >= value.length) return null;
    bindings.set(element.name, value[index]);
  }
  return bindings;
}

function mappedCallback(expression: Expression): {
  readonly sourceName: string;
  readonly callback: CallbackExpression;
} | null {
  if (expression.type !== 'CallExpression' || expression.arguments.length !== 1) return null;
  if (!isMemberCall(expression, 'map') || expression.callee.object.type !== 'Identifier') return null;
  const callback = expression.arguments[0];
  return isCallback(callback)
    ? { sourceName: expression.callee.object.name, callback }
    : null;
}

function awaitedPromiseAllInput(expression: Expression | null | undefined): Expression | null {
  const call = awaitedCall(expression);
  if (!call || call.arguments.length !== 1 || !isMemberCall(call, 'all')) return null;
  if (call.callee.object.type !== 'Identifier' || call.callee.object.name !== 'Promise') return null;
  const argument = call.arguments[0];
  return argument.type === 'SpreadElement' ? null : argument;
}

function awaitedCall(expression: Expression | null | undefined): CallExpression | null {
  return expression?.type === 'AwaitExpression' && expression.argument.type === 'CallExpression'
    ? expression.argument
    : null;
}

function unwrapCall(expression: Expression | null | undefined): CallExpression | null {
  if (expression?.type === 'CallExpression') return expression;
  return awaitedCall(expression);
}

function isToolsExecCommandCall(call: CallExpression): boolean {
  return isMemberCall(call, 'exec_command')
    && call.callee.object.type === 'Identifier'
    && call.callee.object.name === 'tools';
}

function isMemberCall(
  call: CallExpression,
  propertyNameValue: string,
): call is CallExpression & { callee: Extract<Expression, { type: 'MemberExpression' }> } {
  return call.callee.type === 'MemberExpression'
    && !call.optional
    && !call.callee.optional
    && !call.callee.computed
    && call.callee.property.type === 'Identifier'
    && call.callee.property.name === propertyNameValue;
}

function singleConstDeclaration(node: AnyNode): VariableDeclaration | null {
  return node.type === 'VariableDeclaration'
    && node.kind === 'const'
    && node.declarations.length === 1
    && Boolean(node.declarations[0].init)
    ? node
    : null;
}

function isSingleIdentifierConst(node: Pattern | VariableDeclaration): boolean {
  return node.type === 'VariableDeclaration'
    && node.kind === 'const'
    && node.declarations.length === 1
    && node.declarations[0].id.type === 'Identifier'
    && !node.declarations[0].init;
}

function isResultBindingExpression(
  expression: Expression,
  resultBindings: ReadonlySet<string>,
): boolean {
  return expression.type === 'Identifier' && resultBindings.has(expression.name);
}

function isCallback(node: AnyNode): node is CallbackExpression {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';
}

function hasReservedTopLevelBinding(program: Program): boolean {
  return program.body.some((statement) => (
    statement.type === 'VariableDeclaration'
    && statement.declarations.some((declaration) => patternBindsReserved(declaration.id))
  ));
}

function patternBindsReserved(pattern: Pattern): boolean {
  if (pattern.type === 'Identifier') return isReservedBinding(pattern.name);
  if (pattern.type === 'ArrayPattern') {
    return pattern.elements.some((element) => element && patternBindsReserved(element));
  }
  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.some((property) => (
      property.type === 'RestElement'
        ? patternBindsReserved(property.argument)
        : patternBindsReserved(property.value)
    ));
  }
  if (pattern.type === 'AssignmentPattern') return patternBindsReserved(pattern.left);
  if (pattern.type === 'RestElement') return patternBindsReserved(pattern.argument);
  return false;
}

function isReservedBinding(name: string): boolean {
  return name === 'tools' || name === 'Promise' || name === 'text';
}
