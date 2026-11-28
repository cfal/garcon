//! The scanner and the error-reporting parse of `jsonc-parser` 3.3.1, which
//! `mergeOpenCodeConfigContent` reads inherited configuration with. It is
//! ported from the package's `lib/esm/impl/scanner.js` and `parser.js` instead
//! of taken from the Rust `jsonc-parser` crate, because the first
//! diagnostic's offset, counted in UTF-16 code units, and its symbolic name
//! are contract text. Only what `parse` uses is kept: token lines and the
//! text of comment tokens are not.
//!
//! MIT License
//!
//! Copyright (c) Microsoft
//!
//! Permission is hereby granted, free of charge, to any person obtaining a copy
//! of this software and associated documentation files (the "Software"), to deal
//! in the Software without restriction, including without limitation the rights
//! to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//! copies of the Software, and to permit persons to whom the Software is
//! furnished to do so, subject to the following conditions:
//!
//! The above copyright notice and this permission notice shall be included in
//! all copies or substantial portions of the Software.
//!
//! THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//! IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//! FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//! AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//! LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//! OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//! SOFTWARE.

use serde_json::{Map, Value};

use crate::js::string_to_number;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseErrorCode {
    InvalidSymbol,
    InvalidNumberFormat,
    PropertyNameExpected,
    ValueExpected,
    ColonExpected,
    CommaExpected,
    CloseBraceExpected,
    CloseBracketExpected,
    EndOfFileExpected,
    InvalidCommentToken,
    UnexpectedEndOfComment,
    UnexpectedEndOfString,
    UnexpectedEndOfNumber,
    InvalidUnicode,
    InvalidEscapeCharacter,
    InvalidCharacter,
}

impl ParseErrorCode {
    /// `printParseErrorCode`: the name the package prints for the code.
    pub fn name(self) -> &'static str {
        match self {
            Self::InvalidSymbol => "InvalidSymbol",
            Self::InvalidNumberFormat => "InvalidNumberFormat",
            Self::PropertyNameExpected => "PropertyNameExpected",
            Self::ValueExpected => "ValueExpected",
            Self::ColonExpected => "ColonExpected",
            Self::CommaExpected => "CommaExpected",
            Self::CloseBraceExpected => "CloseBraceExpected",
            Self::CloseBracketExpected => "CloseBracketExpected",
            Self::EndOfFileExpected => "EndOfFileExpected",
            Self::InvalidCommentToken => "InvalidCommentToken",
            Self::UnexpectedEndOfComment => "UnexpectedEndOfComment",
            Self::UnexpectedEndOfString => "UnexpectedEndOfString",
            Self::UnexpectedEndOfNumber => "UnexpectedEndOfNumber",
            Self::InvalidUnicode => "InvalidUnicode",
            Self::InvalidEscapeCharacter => "InvalidEscapeCharacter",
            Self::InvalidCharacter => "InvalidCharacter",
        }
    }
}

/// One diagnostic of `parse`: its code and where its token starts and ends,
/// in UTF-16 code units.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseError {
    pub code: ParseErrorCode,
    pub offset: usize,
    pub length: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseOptions {
    pub disallow_comments: bool,
    pub allow_trailing_comma: bool,
    pub allow_empty_content: bool,
}

/// Parses text with comments as fault tolerant as the package's `parse` and
/// reports every diagnostic in the order it found them. `None` is the
/// `undefined` the package returns for content that holds no value.
pub fn parse(text: &str, options: ParseOptions) -> (Option<Value>, Vec<ParseError>) {
    let units: Vec<u16> = text.encode_utf16().collect();
    Parser {
        scanner: Scanner::new(&units),
        options,
        errors: Vec::new(),
        containers: Vec::new(),
        root: Vec::new(),
    }
    .run()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Token {
    Unknown,
    Eof,
    OpenBrace,
    CloseBrace,
    OpenBracket,
    CloseBracket,
    Colon,
    Comma,
    StringLiteral,
    NumericLiteral,
    LineBreakTrivia,
    Trivia,
    LineCommentTrivia,
    BlockCommentTrivia,
    TrueKeyword,
    FalseKeyword,
    NullKeyword,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanError {
    None,
    UnexpectedEndOfComment,
    UnexpectedEndOfString,
    UnexpectedEndOfNumber,
    InvalidUnicode,
    InvalidEscapeCharacter,
    InvalidCharacter,
}

const TAB: u32 = 9;
const LINE_FEED: u32 = 10;
const CARRIAGE_RETURN: u32 = 13;
const SPACE: u32 = 32;
const DOUBLE_QUOTE: u32 = 34;
const ASTERISK: u32 = 42;
const PLUS: u32 = 43;
const COMMA: u32 = 44;
const MINUS: u32 = 45;
const DOT: u32 = 46;
const SLASH: u32 = 47;
const ZERO: u32 = 48;
const NINE: u32 = 57;
const COLON: u32 = 58;
const UPPER_A: u32 = 65;
const UPPER_E: u32 = 69;
const UPPER_F: u32 = 70;
const OPEN_BRACKET: u32 = 91;
const BACKSLASH: u32 = 92;
const CLOSE_BRACKET: u32 = 93;
const LOWER_A: u32 = 97;
const LOWER_B: u32 = 98;
const LOWER_E: u32 = 101;
const LOWER_F: u32 = 102;
const LOWER_N: u32 = 110;
const LOWER_R: u32 = 114;
const LOWER_T: u32 = 116;
const LOWER_U: u32 = 117;
const OPEN_BRACE: u32 = 123;
const CLOSE_BRACE: u32 = 125;

fn is_white_space(code: u32) -> bool {
    code == SPACE || code == TAB
}

fn is_line_break(code: u32) -> bool {
    code == LINE_FEED || code == CARRIAGE_RETURN
}

fn is_digit(code: u32) -> bool {
    (ZERO..=NINE).contains(&code)
}

fn is_unknown_content_character(code: u32) -> bool {
    if is_white_space(code) || is_line_break(code) {
        return false;
    }
    !matches!(
        code,
        CLOSE_BRACE
            | CLOSE_BRACKET
            | OPEN_BRACE
            | OPEN_BRACKET
            | DOUBLE_QUOTE
            | COLON
            | COMMA
            | SLASH
    )
}

struct Scanner<'a> {
    text: &'a [u16],
    pos: usize,
    value: Vec<u16>,
    token_offset: usize,
    token: Token,
    scan_error: ScanError,
}

impl<'a> Scanner<'a> {
    fn new(text: &'a [u16]) -> Self {
        Self {
            text,
            pos: 0,
            value: Vec::new(),
            token_offset: 0,
            token: Token::Unknown,
            scan_error: ScanError::None,
        }
    }

    // The UTF-16 code unit at `pos`. Past the end the package reads `NaN`
    // from `charCodeAt`; zero stands in for it, because every comparison the
    // scanner makes answers the same for the two.
    fn code(&self, pos: usize) -> u32 {
        self.text.get(pos).map_or(0, |unit| u32::from(*unit))
    }

    fn set(&mut self, token: Token) -> Token {
        self.token = token;
        token
    }

    fn text_at(&self, start: usize, end: usize) -> Vec<u16> {
        let end = end.min(self.text.len());
        self.text[start.min(end)..end].to_vec()
    }

    fn value_text(&self) -> String {
        String::from_utf16_lossy(&self.value)
    }

    fn scan_hex_digits(&mut self, count: usize, exact: bool) -> i32 {
        let mut digits = 0;
        let mut value: i32 = 0;
        while digits < count || !exact {
            let digit = match self.code(self.pos) {
                code @ ZERO..=NINE => code - ZERO,
                code @ UPPER_A..=UPPER_F => code - UPPER_A + 10,
                code @ LOWER_A..=LOWER_F => code - LOWER_A + 10,
                _ => break,
            };
            value = value.wrapping_mul(16).wrapping_add(digit as i32);
            self.pos += 1;
            digits += 1;
        }
        if digits < count {
            value = -1;
        }
        value
    }

    fn scan_number(&mut self) -> Vec<u16> {
        let start = self.pos;
        if self.code(self.pos) == ZERO {
            self.pos += 1;
        } else {
            self.pos += 1;
            while self.pos < self.text.len() && is_digit(self.code(self.pos)) {
                self.pos += 1;
            }
        }
        if self.code(self.pos) == DOT {
            self.pos += 1;
            if is_digit(self.code(self.pos)) {
                self.pos += 1;
                while self.pos < self.text.len() && is_digit(self.code(self.pos)) {
                    self.pos += 1;
                }
            } else {
                self.scan_error = ScanError::UnexpectedEndOfNumber;
                return self.text_at(start, self.pos);
            }
        }
        let mut end = self.pos;
        let exponent = self.code(self.pos);
        if exponent == UPPER_E || exponent == LOWER_E {
            self.pos += 1;
            let sign = self.code(self.pos);
            if sign == PLUS || sign == MINUS {
                self.pos += 1;
            }
            if is_digit(self.code(self.pos)) {
                self.pos += 1;
                while self.pos < self.text.len() && is_digit(self.code(self.pos)) {
                    self.pos += 1;
                }
                end = self.pos;
            } else {
                self.scan_error = ScanError::UnexpectedEndOfNumber;
            }
        }
        self.text_at(start, end)
    }

    fn scan_string(&mut self) -> Vec<u16> {
        let mut result = Vec::new();
        let mut start = self.pos;
        loop {
            if self.pos >= self.text.len() {
                result.extend(self.text_at(start, self.pos));
                self.scan_error = ScanError::UnexpectedEndOfString;
                break;
            }
            let ch = self.code(self.pos);
            if ch == DOUBLE_QUOTE {
                result.extend(self.text_at(start, self.pos));
                self.pos += 1;
                break;
            }
            if ch == BACKSLASH {
                result.extend(self.text_at(start, self.pos));
                self.pos += 1;
                if self.pos >= self.text.len() {
                    self.scan_error = ScanError::UnexpectedEndOfString;
                    break;
                }
                let escaped = self.code(self.pos);
                self.pos += 1;
                match escaped {
                    DOUBLE_QUOTE => result.push(b'"' as u16),
                    BACKSLASH => result.push(b'\\' as u16),
                    SLASH => result.push(b'/' as u16),
                    LOWER_B => result.push(8),
                    LOWER_F => result.push(12),
                    LOWER_N => result.push(b'\n' as u16),
                    LOWER_R => result.push(b'\r' as u16),
                    LOWER_T => result.push(b'\t' as u16),
                    LOWER_U => {
                        let hex = self.scan_hex_digits(4, true);
                        if hex >= 0 {
                            result.push(hex as u16);
                        } else {
                            self.scan_error = ScanError::InvalidUnicode;
                        }
                    }
                    _ => self.scan_error = ScanError::InvalidEscapeCharacter,
                }
                start = self.pos;
                continue;
            }
            if ch <= 31 {
                if is_line_break(ch) {
                    result.extend(self.text_at(start, self.pos));
                    self.scan_error = ScanError::UnexpectedEndOfString;
                    break;
                }
                // The package marks the string as faulty and goes on reading it.
                self.scan_error = ScanError::InvalidCharacter;
            }
            self.pos += 1;
        }
        result
    }

    // Scans the next token of any kind, trivia included.
    fn scan(&mut self) -> Token {
        self.value.clear();
        self.scan_error = ScanError::None;
        self.token_offset = self.pos;
        let len = self.text.len();
        if self.pos >= len {
            self.token_offset = len;
            return self.set(Token::Eof);
        }
        let mut code = self.code(self.pos);
        if is_white_space(code) {
            loop {
                self.pos += 1;
                self.value.push(code as u16);
                code = self.code(self.pos);
                if !is_white_space(code) {
                    break;
                }
            }
            return self.set(Token::Trivia);
        }
        if is_line_break(code) {
            self.pos += 1;
            self.value.push(code as u16);
            if code == CARRIAGE_RETURN && self.code(self.pos) == LINE_FEED {
                self.pos += 1;
                self.value.push(b'\n' as u16);
            }
            return self.set(Token::LineBreakTrivia);
        }
        match code {
            OPEN_BRACE => {
                self.pos += 1;
                self.set(Token::OpenBrace)
            }
            CLOSE_BRACE => {
                self.pos += 1;
                self.set(Token::CloseBrace)
            }
            OPEN_BRACKET => {
                self.pos += 1;
                self.set(Token::OpenBracket)
            }
            CLOSE_BRACKET => {
                self.pos += 1;
                self.set(Token::CloseBracket)
            }
            COLON => {
                self.pos += 1;
                self.set(Token::Colon)
            }
            COMMA => {
                self.pos += 1;
                self.set(Token::Comma)
            }
            DOUBLE_QUOTE => {
                self.pos += 1;
                self.value = self.scan_string();
                self.set(Token::StringLiteral)
            }
            SLASH => self.scan_comment(),
            MINUS => {
                self.value.push(code as u16);
                self.pos += 1;
                if self.pos == len || !is_digit(self.code(self.pos)) {
                    return self.set(Token::Unknown);
                }
                let number = self.scan_number();
                self.value.extend(number);
                self.set(Token::NumericLiteral)
            }
            ZERO..=NINE => {
                let number = self.scan_number();
                self.value.extend(number);
                self.set(Token::NumericLiteral)
            }
            _ => {
                while self.pos < len && is_unknown_content_character(code) {
                    self.pos += 1;
                    code = self.code(self.pos);
                }
                if self.token_offset != self.pos {
                    self.value = self.text_at(self.token_offset, self.pos);
                    return match self.value_text().as_str() {
                        "true" => self.set(Token::TrueKeyword),
                        "false" => self.set(Token::FalseKeyword),
                        "null" => self.set(Token::NullKeyword),
                        _ => self.set(Token::Unknown),
                    };
                }
                self.value.push(code as u16);
                self.pos += 1;
                self.set(Token::Unknown)
            }
        }
    }

    // A line comment, a block comment, or a lone slash.
    fn scan_comment(&mut self) -> Token {
        let len = self.text.len();
        // The package measures a comment's text from one unit before its slash.
        let start = self.pos.saturating_sub(1);
        if self.code(self.pos + 1) == SLASH {
            self.pos += 2;
            while self.pos < len {
                if is_line_break(self.code(self.pos)) {
                    break;
                }
                self.pos += 1;
            }
            self.value = self.text_at(start, self.pos);
            return self.set(Token::LineCommentTrivia);
        }
        if self.code(self.pos + 1) == ASTERISK {
            self.pos += 2;
            let safe_length = len - 1;
            let mut comment_closed = false;
            while self.pos < safe_length {
                let ch = self.code(self.pos);
                if ch == ASTERISK && self.code(self.pos + 1) == SLASH {
                    self.pos += 2;
                    comment_closed = true;
                    break;
                }
                self.pos += 1;
                if ch == CARRIAGE_RETURN && self.code(self.pos) == LINE_FEED {
                    self.pos += 1;
                }
            }
            if !comment_closed {
                self.pos += 1;
                self.scan_error = ScanError::UnexpectedEndOfComment;
            }
            self.value = self.text_at(start, self.pos);
            return self.set(Token::BlockCommentTrivia);
        }
        self.value.push(SLASH as u16);
        self.pos += 1;
        self.set(Token::Unknown)
    }
}

enum Container {
    Array(Vec<Value>),
    // `property` is the name the package's `parse` holds until the property's
    // value arrives.
    Object {
        members: Map<String, Value>,
        property: Option<String>,
    },
}

// The package's `visit` with the listener of its `parse`, which builds the
// value and collects every diagnostic.
struct Parser<'a> {
    scanner: Scanner<'a>,
    options: ParseOptions,
    errors: Vec<ParseError>,
    // The arrays and objects still being filled, the innermost last.
    containers: Vec<Container>,
    // The root list of the package's `parse`; its first value is the result.
    root: Vec<Value>,
}

impl Parser<'_> {
    fn run(mut self) -> (Option<Value>, Vec<ParseError>) {
        self.scan_next();
        if self.scanner.token == Token::Eof {
            if !self.options.allow_empty_content {
                self.handle_error(ParseErrorCode::ValueExpected, &[], &[]);
            }
        } else if !self.parse_value() {
            self.handle_error(ParseErrorCode::ValueExpected, &[], &[]);
        } else if self.scanner.token != Token::Eof {
            self.handle_error(ParseErrorCode::EndOfFileExpected, &[], &[]);
        }
        // The package links an array or object to its parent as soon as it
        // begins, so one left open by faulty input is still part of the result.
        while !self.containers.is_empty() {
            self.close_container();
        }
        (self.root.into_iter().next(), self.errors)
    }

    // Reports each scanner error, skips trivia, and returns the next token.
    fn scan_next(&mut self) -> Token {
        loop {
            let token = self.scanner.scan();
            let reported = match self.scanner.scan_error {
                ScanError::None => None,
                ScanError::InvalidUnicode => Some(ParseErrorCode::InvalidUnicode),
                ScanError::InvalidEscapeCharacter => Some(ParseErrorCode::InvalidEscapeCharacter),
                ScanError::UnexpectedEndOfNumber => Some(ParseErrorCode::UnexpectedEndOfNumber),
                ScanError::UnexpectedEndOfString => Some(ParseErrorCode::UnexpectedEndOfString),
                ScanError::InvalidCharacter => Some(ParseErrorCode::InvalidCharacter),
                ScanError::UnexpectedEndOfComment => (!self.options.disallow_comments)
                    .then_some(ParseErrorCode::UnexpectedEndOfComment),
            };
            if let Some(code) = reported {
                self.handle_error(code, &[], &[]);
            }
            match token {
                Token::LineCommentTrivia | Token::BlockCommentTrivia => {
                    if self.options.disallow_comments {
                        self.handle_error(ParseErrorCode::InvalidCommentToken, &[], &[]);
                    }
                }
                Token::Unknown => self.handle_error(ParseErrorCode::InvalidSymbol, &[], &[]),
                Token::Trivia | Token::LineBreakTrivia => {}
                _ => return token,
            }
        }
    }

    // Records the error for the current token, then optionally skips tokens
    // until one of `skip_until` is current, or until just after one of
    // `skip_until_after`.
    fn handle_error(
        &mut self,
        code: ParseErrorCode,
        skip_until_after: &[Token],
        skip_until: &[Token],
    ) {
        self.errors.push(ParseError {
            code,
            offset: self.scanner.token_offset,
            length: self.scanner.pos - self.scanner.token_offset,
        });
        if skip_until_after.is_empty() && skip_until.is_empty() {
            return;
        }
        let mut token = self.scanner.token;
        while token != Token::Eof {
            if skip_until_after.contains(&token) {
                self.scan_next();
                break;
            } else if skip_until.contains(&token) {
                break;
            }
            token = self.scan_next();
        }
    }

    fn on_value(&mut self, value: Value) {
        match self.containers.last_mut() {
            Some(Container::Array(items)) => items.push(value),
            Some(Container::Object { members, property }) => {
                // A property without a name yet has nowhere to hold the value.
                if let Some(property) = property {
                    members.insert(property.clone(), value);
                }
            }
            None => self.root.push(value),
        }
    }

    fn parse_value(&mut self) -> bool {
        match self.scanner.token {
            Token::OpenBracket => self.parse_array(),
            Token::OpenBrace => self.parse_object(),
            Token::StringLiteral => self.parse_string(true),
            _ => self.parse_literal(),
        }
    }

    fn parse_string(&mut self, is_value: bool) -> bool {
        let value = self.scanner.value_text();
        if is_value {
            self.on_value(Value::String(value));
        } else if let Some(Container::Object { property, .. }) = self.containers.last_mut() {
            *property = Some(value);
        }
        self.scan_next();
        true
    }

    fn parse_literal(&mut self) -> bool {
        match self.scanner.token {
            Token::NumericLiteral => {
                let number = string_to_number(&self.scanner.value_text());
                let value = if number.is_nan() {
                    self.handle_error(ParseErrorCode::InvalidNumberFormat, &[], &[]);
                    0.0
                } else {
                    number
                };
                self.on_value(Value::from(value));
            }
            Token::NullKeyword => self.on_value(Value::Null),
            Token::TrueKeyword => self.on_value(Value::Bool(true)),
            Token::FalseKeyword => self.on_value(Value::Bool(false)),
            _ => return false,
        }
        self.scan_next();
        true
    }

    fn parse_property(&mut self) -> bool {
        if self.scanner.token != Token::StringLiteral {
            self.handle_error(
                ParseErrorCode::PropertyNameExpected,
                &[],
                &[Token::CloseBrace, Token::Comma],
            );
            return false;
        }
        self.parse_string(false);
        if self.scanner.token == Token::Colon {
            self.scan_next();
            if !self.parse_value() {
                self.handle_error(
                    ParseErrorCode::ValueExpected,
                    &[],
                    &[Token::CloseBrace, Token::Comma],
                );
            }
        } else {
            self.handle_error(
                ParseErrorCode::ColonExpected,
                &[],
                &[Token::CloseBrace, Token::Comma],
            );
        }
        true
    }

    fn parse_object(&mut self) -> bool {
        self.containers.push(Container::Object {
            members: Map::new(),
            property: None,
        });
        self.scan_next();
        let mut needs_comma = false;
        while !matches!(self.scanner.token, Token::CloseBrace | Token::Eof) {
            if self.scanner.token == Token::Comma {
                if !needs_comma {
                    self.handle_error(ParseErrorCode::ValueExpected, &[], &[]);
                }
                self.scan_next();
                if self.scanner.token == Token::CloseBrace && self.options.allow_trailing_comma {
                    break;
                }
            } else if needs_comma {
                self.handle_error(ParseErrorCode::CommaExpected, &[], &[]);
            }
            if !self.parse_property() {
                self.handle_error(
                    ParseErrorCode::ValueExpected,
                    &[],
                    &[Token::CloseBrace, Token::Comma],
                );
            }
            needs_comma = true;
        }
        self.close_container();
        if self.scanner.token != Token::CloseBrace {
            self.handle_error(
                ParseErrorCode::CloseBraceExpected,
                &[Token::CloseBrace],
                &[],
            );
        } else {
            self.scan_next();
        }
        true
    }

    fn parse_array(&mut self) -> bool {
        self.containers.push(Container::Array(Vec::new()));
        self.scan_next();
        let mut needs_comma = false;
        while !matches!(self.scanner.token, Token::CloseBracket | Token::Eof) {
            if self.scanner.token == Token::Comma {
                if !needs_comma {
                    self.handle_error(ParseErrorCode::ValueExpected, &[], &[]);
                }
                self.scan_next();
                if self.scanner.token == Token::CloseBracket && self.options.allow_trailing_comma {
                    break;
                }
            } else if needs_comma {
                self.handle_error(ParseErrorCode::CommaExpected, &[], &[]);
            }
            if !self.parse_value() {
                self.handle_error(
                    ParseErrorCode::ValueExpected,
                    &[],
                    &[Token::CloseBracket, Token::Comma],
                );
            }
            needs_comma = true;
        }
        self.close_container();
        if self.scanner.token != Token::CloseBracket {
            self.handle_error(
                ParseErrorCode::CloseBracketExpected,
                &[Token::CloseBracket],
                &[],
            );
        } else {
            self.scan_next();
        }
        true
    }

    // Gives the innermost finished array or object to its parent, or to the root.
    fn close_container(&mut self) {
        match self.containers.pop() {
            Some(Container::Array(items)) => self.on_value(Value::Array(items)),
            Some(Container::Object { members, .. }) => self.on_value(Value::Object(members)),
            None => {}
        }
    }
}
