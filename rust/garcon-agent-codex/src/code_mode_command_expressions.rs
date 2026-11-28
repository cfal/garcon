use std::collections::HashMap;

use oxc_ast::ast::{
    ArrayExpressionElement, CallExpression, ChainElement, Expression, ObjectProperty,
    ObjectPropertyKind, PropertyKey, PropertyKind,
};

pub(super) enum StaticValue {
    String(String),
    Scalar,
    Array(Vec<StaticValue>),
}

pub(super) type StaticBindings<'a> = HashMap<&'a str, &'a StaticValue>;

pub(super) fn is_pure_reporter_expression(expression: &Expression<'_>) -> bool {
    is_expression(expression, ExpressionPolicy::Reporter)
}

pub(super) fn is_data_expression(expression: &Expression<'_>) -> bool {
    is_expression(expression, ExpressionPolicy::Data)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ExpressionPolicy {
    Reporter,
    Data,
}

fn is_expression(expression: &Expression<'_>, policy: ExpressionPolicy) -> bool {
    let test = |value: &Expression<'_>| is_expression(value, policy);
    match expression {
        Expression::Identifier(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BigIntLiteral(_)
        | Expression::RegExpLiteral(_)
        | Expression::StringLiteral(_) => true,
        Expression::TemplateLiteral(value) => value.expressions.iter().all(test),
        Expression::StaticMemberExpression(value) => test(&value.object),
        Expression::ComputedMemberExpression(value) => {
            test(&value.object) && test(&value.expression)
        }
        Expression::PrivateFieldExpression(value) => test(&value.object),
        Expression::UnaryExpression(value) => !value.operator.is_delete() && test(&value.argument),
        Expression::BinaryExpression(value) => test(&value.left) && test(&value.right),
        Expression::LogicalExpression(value) => test(&value.left) && test(&value.right),
        Expression::ConditionalExpression(value) => {
            test(&value.test) && test(&value.consequent) && test(&value.alternate)
        }
        Expression::ArrayExpression(value) => value.elements.iter().all(|item| match item {
            ArrayExpressionElement::Elision(_) => policy == ExpressionPolicy::Reporter,
            _ => item.as_expression().is_some_and(test),
        }),
        Expression::ObjectExpression(value) => value
            .properties
            .iter()
            .all(|property| data_property(property).is_some_and(|property| test(&property.value))),
        Expression::SequenceExpression(value) => {
            policy == ExpressionPolicy::Reporter && value.expressions.iter().all(test)
        }
        Expression::ChainExpression(value) => match &value.expression {
            ChainElement::StaticMemberExpression(value) => test(&value.object),
            ChainElement::ComputedMemberExpression(value) => {
                test(&value.object) && test(&value.expression)
            }
            ChainElement::PrivateFieldExpression(value) => test(&value.object),
            ChainElement::CallExpression(value) => {
                policy == ExpressionPolicy::Reporter && is_known_pure_reporter_call(value)
            }
            _ => false,
        },
        Expression::ParenthesizedExpression(value) => test(&value.expression),
        Expression::CallExpression(value) => {
            policy == ExpressionPolicy::Reporter && is_known_pure_reporter_call(value)
        }
        _ => false,
    }
}

pub(super) fn data_property<'p, 'a>(
    property: &'p ObjectPropertyKind<'a>,
) -> Option<&'p ObjectProperty<'a>> {
    match property {
        ObjectPropertyKind::ObjectProperty(property)
            if property.kind == PropertyKind::Init
                && !property.method
                && !property.key.is_expression() =>
        {
            Some(property)
        }
        _ => None,
    }
}

pub(super) fn property_name<'p>(key: &'p PropertyKey<'_>) -> Option<&'p str> {
    match key {
        PropertyKey::StaticIdentifier(value) => Some(value.name.as_str()),
        PropertyKey::StaticStringLiteral(value) => value.value.as_str(),
        _ => None,
    }
}

pub(super) fn resolve_static_string(
    expression: &Expression<'_>,
    bindings: &StaticBindings<'_>,
) -> Option<String> {
    match expression {
        Expression::StringLiteral(value) => Some(
            value
                .value
                .chars()
                .map(|ch| ch.to_char().unwrap_or('\u{fffd}'))
                .collect(),
        ),
        Expression::TemplateLiteral(value) if value.expressions.is_empty() => {
            let value = &value.quasis.first()?.value;
            Some(value.cooked.map_or_else(
                || value.raw.to_string(),
                |value| {
                    value
                        .chars()
                        .map(|ch| ch.to_char().unwrap_or('\u{fffd}'))
                        .collect()
                },
            ))
        }
        Expression::Identifier(value) => binding_string(bindings.get(value.name.as_str())?),
        Expression::ComputedMemberExpression(value) => {
            let Expression::Identifier(object) = &value.object else {
                return None;
            };
            let Expression::NumericLiteral(index) = &value.expression else {
                return None;
            };
            let StaticValue::Array(items) = bindings.get(object.name.as_str())? else {
                return None;
            };
            let index = index.value;
            if !index.is_finite()
                || index.fract() != 0.0
                || index < 0.0
                || index >= items.len() as f64
            {
                return None;
            }
            binding_string(items.get(index as usize)?)
        }
        _ => None,
    }
}

fn binding_string(value: &StaticValue) -> Option<String> {
    match value {
        StaticValue::String(value) => Some(value.clone()),
        _ => None,
    }
}

pub(super) fn static_value(expression: &Expression<'_>) -> Option<StaticValue> {
    match expression {
        Expression::StringLiteral(_) | Expression::TemplateLiteral(_) => {
            resolve_static_string(expression, &HashMap::new()).map(StaticValue::String)
        }
        Expression::NumericLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_) => Some(StaticValue::Scalar),
        Expression::ArrayExpression(value) => value
            .elements
            .iter()
            .map(|element| static_value(element.as_expression()?))
            .collect::<Option<_>>()
            .map(StaticValue::Array),
        _ => None,
    }
}

pub(super) fn member_call<'p, 'a>(
    call: &'p CallExpression<'a>,
    name: &str,
) -> Option<&'p Expression<'a>> {
    match &call.callee {
        Expression::StaticMemberExpression(callee)
            if !call.optional && !callee.optional && callee.property.name == name =>
        {
            Some(&callee.object)
        }
        _ => None,
    }
}

pub(super) fn is_identifier(expression: &Expression<'_>, name: &str) -> bool {
    matches!(expression, Expression::Identifier(value) if value.name == name)
}

fn is_known_pure_reporter_call(call: &CallExpression<'_>) -> bool {
    if !call.arguments.iter().all(|argument| {
        argument
            .as_expression()
            .is_some_and(is_pure_reporter_expression)
    }) {
        return false;
    }
    if let Expression::Identifier(value) = &call.callee {
        return matches!(value.name.as_str(), "String" | "Number" | "Boolean");
    }
    if let Some(object) = member_call(call, "stringify") {
        return is_identifier(object, "JSON");
    }
    member_call(call, "join").is_some_and(is_pure_reporter_expression)
}
