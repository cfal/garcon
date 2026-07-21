import type { Expression } from 'acorn';

export type StaticValue = string | number | boolean | null | StaticValue[];
export type StaticBindings = ReadonlyMap<string, StaticValue>;

export function isPureReporterExpression(expression: Expression): boolean {
  switch (expression.type) {
    case 'Identifier':
    case 'Literal':
      return true;
    case 'TemplateLiteral':
      return expression.expressions.every(isPureReporterExpression);
    case 'MemberExpression':
      return expression.object.type !== 'Super'
        && isPureReporterExpression(expression.object)
        && (!expression.computed || (
          expression.property.type !== 'PrivateIdentifier'
          && isPureReporterExpression(expression.property)
        ));
    case 'UnaryExpression':
      return expression.operator !== 'delete' && isPureReporterExpression(expression.argument);
    case 'BinaryExpression':
      return expression.left.type !== 'PrivateIdentifier'
        && isPureReporterExpression(expression.left)
        && isPureReporterExpression(expression.right);
    case 'LogicalExpression':
      return isPureReporterExpression(expression.left) && isPureReporterExpression(expression.right);
    case 'ConditionalExpression':
      return isPureReporterExpression(expression.test)
        && isPureReporterExpression(expression.consequent)
        && isPureReporterExpression(expression.alternate);
    case 'ArrayExpression':
      return expression.elements.every((element) => (
        element === null
        || (element.type !== 'SpreadElement' && isPureReporterExpression(element))
      ));
    case 'ObjectExpression':
      return expression.properties.every((property) => (
        property.type === 'Property'
        && property.kind === 'init'
        && !property.method
        && !property.computed
        && isPureReporterExpression(property.value)
      ));
    case 'SequenceExpression':
      return expression.expressions.every(isPureReporterExpression);
    case 'ChainExpression':
    case 'ParenthesizedExpression':
      return isPureReporterExpression(expression.expression);
    case 'CallExpression':
      return isKnownPureReporterCall(expression);
    default:
      return false;
  }
}

export function isDataExpression(expression: Expression): boolean {
  switch (expression.type) {
    case 'Identifier':
    case 'Literal':
      return true;
    case 'TemplateLiteral':
      return expression.expressions.every(isDataExpression);
    case 'MemberExpression':
      return expression.object.type !== 'Super'
        && isDataExpression(expression.object)
        && (!expression.computed || (
          expression.property.type !== 'PrivateIdentifier'
          && isDataExpression(expression.property)
        ));
    case 'UnaryExpression':
      return expression.operator !== 'delete' && isDataExpression(expression.argument);
    case 'BinaryExpression':
      return expression.left.type !== 'PrivateIdentifier'
        && isDataExpression(expression.left)
        && isDataExpression(expression.right);
    case 'LogicalExpression':
      return isDataExpression(expression.left) && isDataExpression(expression.right);
    case 'ConditionalExpression':
      return isDataExpression(expression.test)
        && isDataExpression(expression.consequent)
        && isDataExpression(expression.alternate);
    case 'ArrayExpression':
      return expression.elements.every((element) => (
        element !== null
        && element.type !== 'SpreadElement'
        && isDataExpression(element)
      ));
    case 'ObjectExpression':
      return expression.properties.every((property) => (
        property.type === 'Property'
        && property.kind === 'init'
        && !property.method
        && !property.computed
        && isDataExpression(property.value)
      ));
    case 'ChainExpression':
    case 'ParenthesizedExpression':
      return isDataExpression(expression.expression);
    default:
      return false;
  }
}

export function resolveStaticString(
  expression: Expression,
  bindings: StaticBindings,
): string | null {
  if (expression.type === 'Literal' && typeof expression.value === 'string') {
    return expression.value;
  }
  if (expression.type === 'TemplateLiteral' && expression.expressions.length === 0) {
    return expression.quasis[0]?.value.cooked ?? expression.quasis[0]?.value.raw ?? null;
  }
  if (expression.type === 'Identifier') {
    const value = bindings.get(expression.name);
    return typeof value === 'string' ? value : null;
  }
  if (
    expression.type === 'MemberExpression'
    && expression.computed
    && expression.object.type === 'Identifier'
    && expression.property.type === 'Literal'
    && typeof expression.property.value === 'number'
    && Number.isInteger(expression.property.value)
  ) {
    const value = bindings.get(expression.object.name);
    const item = Array.isArray(value) ? value[expression.property.value] : null;
    return typeof item === 'string' ? item : null;
  }
  return null;
}

export function staticValue(expression: Expression): StaticValue | undefined {
  if (expression.type === 'Literal') {
    return typeof expression.value === 'string'
      || typeof expression.value === 'number'
      || typeof expression.value === 'boolean'
      || expression.value === null
      ? expression.value
      : undefined;
  }
  if (expression.type === 'TemplateLiteral' && expression.expressions.length === 0) {
    return expression.quasis[0]?.value.cooked ?? expression.quasis[0]?.value.raw;
  }
  if (expression.type === 'ArrayExpression') {
    const values = expression.elements.map((element) => (
      element && element.type !== 'SpreadElement' ? staticValue(element) : undefined
    ));
    return values.some((value) => value === undefined) ? undefined : values as StaticValue[];
  }
  return undefined;
}

export function propertyName(expression: Expression): string | null {
  if (expression.type === 'Identifier') return expression.name;
  return expression.type === 'Literal' && typeof expression.value === 'string'
    ? expression.value
    : null;
}

function isKnownPureReporterCall(call: Extract<Expression, { type: 'CallExpression' }>): boolean {
  if (!call.arguments.every((argument) => (
    argument.type !== 'SpreadElement' && isPureReporterExpression(argument)
  ))) return false;
  if (call.callee.type === 'Identifier') {
    return call.callee.name === 'String'
      || call.callee.name === 'Number'
      || call.callee.name === 'Boolean';
  }
  if (isMemberCall(call, 'stringify')) {
    return call.callee.object.type === 'Identifier' && call.callee.object.name === 'JSON';
  }
  return isMemberCall(call, 'join')
    && call.callee.object.type !== 'Super'
    && isPureReporterExpression(call.callee.object);
}

function isMemberCall(
  call: Extract<Expression, { type: 'CallExpression' }>,
  propertyNameValue: string,
): call is Extract<Expression, { type: 'CallExpression' }> & {
  callee: Extract<Expression, { type: 'MemberExpression' }>;
} {
  return call.callee.type === 'MemberExpression'
    && !call.optional
    && !call.callee.optional
    && !call.callee.computed
    && call.callee.property.type === 'Identifier'
    && call.callee.property.name === propertyNameValue;
}
