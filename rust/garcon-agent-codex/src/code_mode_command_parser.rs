use std::collections::HashMap;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    ArrowFunctionBody, BindingPattern, CallExpression, Expression, ForStatementLeft,
    FormalParameters, FunctionBody, Program, Statement, VariableDeclaration,
    VariableDeclarationKind, VariableDeclarator,
};
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use serde::Serialize;

use crate::code_mode_command_expressions::{
    StaticBindings, StaticValue, data_property, is_data_expression, is_identifier,
    is_pure_reporter_expression, member_call, property_name, resolve_static_string, static_value,
};

const MAX_SOURCE_BYTES: usize = 64 * 1024;
const MAX_COMMANDS: usize = 64;

struct RecognizedProgram<'a> {
    commands: Vec<String>,
    result_statement: usize,
    source_statement: Option<usize>,
    result_binding: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CodexCodeModeCommandProjection {
    pub commands: Vec<String>,
}

pub fn project_codex_code_mode_commands(source: &str) -> Option<CodexCodeModeCommandProjection> {
    if source.len() > MAX_SOURCE_BYTES {
        return None;
    }
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::mjs())
        .with_options(ParseOptions {
            parse_regular_expression: true,
            preserve_parens: false,
            ..ParseOptions::default()
        })
        .parse();
    if !parsed.diagnostics.is_empty() {
        return None;
    }
    let program = &parsed.program;
    if !SemanticBuilder::new()
        .with_check_syntax_error(true)
        .build(program)
        .diagnostics
        .is_empty()
    {
        return None;
    }
    if has_reserved_top_level_binding(program) {
        return None;
    }
    let recognized = recognize_direct_command(program)
        .or_else(|| recognize_literal_batch(program))
        .or_else(|| recognize_mapped_batch(program))?;
    if recognized.commands.is_empty()
        || recognized.commands.len() > MAX_COMMANDS
        || recognized.commands.iter().any(String::is_empty)
        || !validate_remaining_program(program, &recognized)
    {
        return None;
    }
    Some(CodexCodeModeCommandProjection {
        commands: recognized.commands,
    })
}

fn recognize_direct_command<'p>(program: &'p Program<'_>) -> Option<RecognizedProgram<'p>> {
    let mut matched = None;
    for (index, statement) in program.body.iter().enumerate() {
        let Some((binding, init)) = single_const_identifier(statement) else {
            continue;
        };
        let Some(call) = awaited_call(init).filter(|call| is_tools_exec_command_call(call)) else {
            continue;
        };
        let command = extract_exec_command(call, &HashMap::new())?;
        if matched.is_some() {
            return None;
        }
        matched = Some(RecognizedProgram {
            commands: vec![command],
            result_statement: index,
            source_statement: None,
            result_binding: binding,
        });
    }
    matched
}

fn recognize_literal_batch<'p>(program: &'p Program<'_>) -> Option<RecognizedProgram<'p>> {
    let mut matched = None;
    for (index, statement) in program.body.iter().enumerate() {
        let Some((binding, init)) = single_const_identifier(statement) else {
            continue;
        };
        let Some(Expression::ArrayExpression(input)) = awaited_promise_all_input(init) else {
            continue;
        };
        let mut commands = Vec::new();
        for element in &input.elements {
            let call = unwrap_call(element.as_expression()?)
                .filter(|call| is_tools_exec_command_call(call))?;
            commands.push(extract_exec_command(call, &HashMap::new())?);
        }
        if matched.is_some() {
            return None;
        }
        matched = Some(RecognizedProgram {
            commands,
            result_statement: index,
            source_statement: None,
            result_binding: binding,
        });
    }
    matched
}

fn recognize_mapped_batch<'p>(program: &'p Program<'_>) -> Option<RecognizedProgram<'p>> {
    let declarations = top_level_const_arrays(program);
    let mut matched = None;
    for (index, statement) in program.body.iter().enumerate() {
        let Some((binding, init)) = single_const_identifier(statement) else {
            continue;
        };
        let Some((source, callback)) = awaited_promise_all_input(init).and_then(mapped_callback)
        else {
            continue;
        };
        let (source_statement, values) = declarations.get(source)?;
        let (pattern, exec) = unconditional_callback_exec(callback)?;
        let mut commands = Vec::new();
        for item in values {
            let bindings = bind_static_pattern(pattern, item)?;
            commands.push(extract_exec_command(exec, &bindings)?);
        }
        if matched.is_some() {
            return None;
        }
        matched = Some(RecognizedProgram {
            commands,
            result_statement: index,
            source_statement: Some(*source_statement),
            result_binding: binding,
        });
    }
    matched
}

fn validate_remaining_program(program: &Program<'_>, recognized: &RecognizedProgram<'_>) -> bool {
    program.directives.is_empty()
        && program.body.iter().enumerate().all(|(index, statement)| {
            index == recognized.result_statement
                || Some(index) == recognized.source_statement
                || is_reporter_statement(statement, recognized.result_binding)
        })
}

fn is_reporter_statement(statement: &Statement<'_>, result_binding: &str) -> bool {
    match statement {
        Statement::EmptyStatement(_) => true,
        Statement::BlockStatement(block) => block
            .body
            .iter()
            .all(|stmt| is_reporter_statement(stmt, result_binding)),
        Statement::ExpressionStatement(stmt) => {
            is_text_call(&stmt.expression)
                || is_result_for_each_call(&stmt.expression, result_binding)
        }
        Statement::VariableDeclaration(declaration) => is_reporter_const(declaration),
        Statement::IfStatement(stmt) => {
            is_pure_reporter_expression(&stmt.test)
                && is_reporter_statement(&stmt.consequent, result_binding)
                && stmt
                    .alternate
                    .as_ref()
                    .is_none_or(|body| is_reporter_statement(body, result_binding))
        }
        Statement::ForOfStatement(stmt) => {
            !stmt.r#await
                && is_single_identifier_const(&stmt.left)
                && is_identifier(&stmt.right, result_binding)
                && is_reporter_statement(&stmt.body, result_binding)
        }
        _ => false,
    }
}

fn is_reporter_const(declaration: &VariableDeclaration<'_>) -> bool {
    declaration.kind == VariableDeclarationKind::Const
        && declaration.declarations.iter().all(|declarator| {
            binding_name(&declarator.id).is_some_and(|name| !is_reserved_binding(name))
                && declarator
                    .init
                    .as_ref()
                    .is_some_and(is_pure_reporter_expression)
        })
}

fn is_result_for_each_call(expression: &Expression<'_>, result_binding: &str) -> bool {
    let Expression::CallExpression(call) = expression else {
        return false;
    };
    let [argument] = call.arguments.as_slice() else {
        return false;
    };
    if !member_call(call, "forEach").is_some_and(|object| is_identifier(object, result_binding)) {
        return false;
    }
    match argument
        .as_expression()
        .and_then(callback_expression)
        .map(|callback| callback.body)
    {
        Some(CallbackBody::Block(body)) => {
            body.directives.is_empty()
                && body
                    .statements
                    .iter()
                    .all(|stmt| is_reporter_statement(stmt, result_binding))
        }
        Some(CallbackBody::Expression(body)) => is_text_call(body),
        None => false,
    }
}

fn is_text_call(expression: &Expression<'_>) -> bool {
    matches!(expression, Expression::CallExpression(call)
        if is_identifier(&call.callee, "text")
            && call.arguments.iter().all(|argument| argument.as_expression().is_some_and(is_pure_reporter_expression)))
}

fn extract_exec_command(
    call: &CallExpression<'_>,
    bindings: &StaticBindings<'_>,
) -> Option<String> {
    let [argument] = call.arguments.as_slice() else {
        return None;
    };
    let Expression::ObjectExpression(argument) = argument.as_expression()? else {
        return None;
    };
    let mut command = None;
    let mut command_properties = 0;
    for property in &argument.properties {
        let property = data_property(property)?;
        if !is_data_expression(&property.value) {
            return None;
        }
        if property_name(&property.key) == Some("cmd") {
            command_properties += 1;
            command = resolve_static_string(&property.value, bindings);
        }
    }
    if command_properties == 1 {
        command
    } else {
        None
    }
}

fn unconditional_callback_exec<'p, 'a>(
    callback: Callback<'p, 'a>,
) -> Option<(&'p BindingPattern<'a>, &'p CallExpression<'a>)> {
    let [param] = callback.params.items.as_slice() else {
        return None;
    };
    if callback.params.rest.is_some()
        || param.initializer.is_some()
        || pattern_binds_reserved(&param.pattern)
    {
        return None;
    }
    let call = match callback.body {
        CallbackBody::Expression(body) => {
            unwrap_call(body).filter(|call| is_tools_exec_command_call(call))?
        }
        CallbackBody::Block(body) => {
            if !body.directives.is_empty() {
                return None;
            }
            let mut found = None;
            for statement in &body.statements {
                if let Some(call) = callback_exec_statement(statement) {
                    if found.is_some() {
                        return None;
                    }
                    found = Some(call);
                } else if !is_callback_local_statement(statement) {
                    return None;
                }
            }
            found?
        }
    };
    Some((&param.pattern, call))
}

fn callback_exec_statement<'p, 'a>(statement: &'p Statement<'a>) -> Option<&'p CallExpression<'a>> {
    let expression = match statement {
        Statement::ReturnStatement(stmt) => stmt.argument.as_ref()?,
        _ => single_const_identifier(statement)?.1,
    };
    unwrap_call(expression).filter(|call| is_tools_exec_command_call(call))
}

fn is_callback_local_statement(statement: &Statement<'_>) -> bool {
    match statement {
        Statement::EmptyStatement(_) => true,
        Statement::ReturnStatement(stmt) => stmt
            .argument
            .as_ref()
            .is_none_or(is_pure_reporter_expression),
        Statement::VariableDeclaration(declaration) => is_reporter_const(declaration),
        _ => false,
    }
}

fn top_level_const_arrays<'p>(
    program: &'p Program<'_>,
) -> HashMap<&'p str, (usize, Vec<StaticValue>)> {
    program
        .body
        .iter()
        .enumerate()
        .filter_map(|(index, statement)| {
            let (name, init) = single_const_identifier(statement)?;
            let Expression::ArrayExpression(init) = init else {
                return None;
            };
            let values = init
                .elements
                .iter()
                .map(|element| static_value(element.as_expression()?))
                .collect::<Option<_>>()?;
            Some((name, (index, values)))
        })
        .collect()
}

fn bind_static_pattern<'a>(
    pattern: &'a BindingPattern<'_>,
    value: &'a StaticValue,
) -> Option<StaticBindings<'a>> {
    let mut bindings = HashMap::new();
    if let Some(name) = binding_name(pattern) {
        bindings.insert(name, value);
        return Some(bindings);
    }
    let (BindingPattern::ArrayPattern(pattern), StaticValue::Array(values)) = (pattern, value)
    else {
        return None;
    };
    if pattern.rest.is_some() {
        return None;
    }
    for (index, element) in pattern.elements.iter().enumerate() {
        if let Some(element) = element {
            bindings.insert(binding_name(element)?, values.get(index)?);
        }
    }
    Some(bindings)
}

fn mapped_callback<'p, 'a>(expression: &'p Expression<'a>) -> Option<(&'p str, Callback<'p, 'a>)> {
    let Expression::CallExpression(call) = expression else {
        return None;
    };
    let [callback] = call.arguments.as_slice() else {
        return None;
    };
    let Expression::Identifier(object) = member_call(call, "map")? else {
        return None;
    };
    Some((
        object.name.as_str(),
        callback_expression(callback.as_expression()?)?,
    ))
}

struct Callback<'p, 'a> {
    params: &'p FormalParameters<'a>,
    body: CallbackBody<'p, 'a>,
}

enum CallbackBody<'p, 'a> {
    Expression(&'p Expression<'a>),
    Block(&'p FunctionBody<'a>),
}

fn callback_expression<'p, 'a>(expression: &'p Expression<'a>) -> Option<Callback<'p, 'a>> {
    match expression {
        Expression::ArrowFunctionExpression(function) => Some(Callback {
            params: &function.params,
            body: match &function.body {
                ArrowFunctionBody::FunctionBody(body) => CallbackBody::Block(body),
                body => CallbackBody::Expression(body.as_expression()?),
            },
        }),
        Expression::FunctionExpression(function) => Some(Callback {
            params: &function.params,
            body: CallbackBody::Block(function.body.as_deref()?),
        }),
        _ => None,
    }
}

fn awaited_promise_all_input<'p, 'a>(expression: &'p Expression<'a>) -> Option<&'p Expression<'a>> {
    let call = awaited_call(expression)?;
    let [argument] = call.arguments.as_slice() else {
        return None;
    };
    if !is_identifier(member_call(call, "all")?, "Promise") {
        return None;
    }
    argument.as_expression()
}

fn awaited_call<'p, 'a>(expression: &'p Expression<'a>) -> Option<&'p CallExpression<'a>> {
    match expression {
        Expression::AwaitExpression(value) => match &value.argument {
            Expression::CallExpression(call) => Some(call),
            _ => None,
        },
        _ => None,
    }
}

fn unwrap_call<'p, 'a>(expression: &'p Expression<'a>) -> Option<&'p CallExpression<'a>> {
    match expression {
        Expression::CallExpression(call) => Some(call),
        _ => awaited_call(expression),
    }
}

fn is_tools_exec_command_call(call: &CallExpression<'_>) -> bool {
    member_call(call, "exec_command").is_some_and(|object| is_identifier(object, "tools"))
}

fn single_const_identifier<'p, 'a>(
    statement: &'p Statement<'a>,
) -> Option<(&'p str, &'p Expression<'a>)> {
    let Statement::VariableDeclaration(declaration) = statement else {
        return None;
    };
    let declarator = single_const_declarator(declaration)?;
    Some((binding_name(&declarator.id)?, declarator.init.as_ref()?))
}

fn single_const_declarator<'p, 'a>(
    declaration: &'p VariableDeclaration<'a>,
) -> Option<&'p VariableDeclarator<'a>> {
    if declaration.kind != VariableDeclarationKind::Const {
        return None;
    }
    match declaration.declarations.as_slice() {
        [declarator] => Some(declarator),
        _ => None,
    }
}

fn is_single_identifier_const(statement: &ForStatementLeft<'_>) -> bool {
    match statement {
        ForStatementLeft::VariableDeclaration(declaration) => single_const_declarator(declaration)
            .is_some_and(|declarator| {
                binding_name(&declarator.id).is_some() && declarator.init.is_none()
            }),
        _ => false,
    }
}

fn binding_name<'p>(pattern: &'p BindingPattern<'_>) -> Option<&'p str> {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => Some(identifier.name.as_str()),
        _ => None,
    }
}

fn has_reserved_top_level_binding(program: &Program<'_>) -> bool {
    program.body.iter().any(|statement| {
        matches!(statement, Statement::VariableDeclaration(declaration)
            if declaration.declarations.iter().any(|declarator| pattern_binds_reserved(&declarator.id)))
    })
}

fn pattern_binds_reserved(pattern: &BindingPattern<'_>) -> bool {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => {
            is_reserved_binding(identifier.name.as_str())
        }
        BindingPattern::ArrayPattern(value) => {
            value.elements.iter().flatten().any(pattern_binds_reserved)
                || value
                    .rest
                    .as_ref()
                    .is_some_and(|rest| pattern_binds_reserved(&rest.argument))
        }
        BindingPattern::ObjectPattern(value) => {
            value
                .properties
                .iter()
                .any(|property| pattern_binds_reserved(&property.value))
                || value
                    .rest
                    .as_ref()
                    .is_some_and(|rest| pattern_binds_reserved(&rest.argument))
        }
        BindingPattern::AssignmentPattern(value) => pattern_binds_reserved(&value.left),
    }
}

fn is_reserved_binding(name: &str) -> bool {
    matches!(name, "tools" | "Promise" | "text")
}
