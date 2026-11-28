//! Ports `server-agents/common/src/lib/jsonl.ts`. The directory is not a
//! module of this crate, because `lib` names the crate root.

use garcon_base::errors::NamedError;
use garcon_js::json::Opaque;
use garcon_js::{trim, trim_end, utf16};

const FAILED_TO_PARSE_JSONL: &str = "Failed to parse JSONL";
const INVALID_JSONL_LINE: &str = "Invalid JSONL line";

#[derive(Debug)]
pub enum JsonlLineResult {
    Empty,
    Value {
        value: Opaque,
        raw: String,
        discarded_suffix: bool,
    },
    Incomplete,
    Invalid {
        error: NamedError,
    },
}

pub fn parse_first_jsonl_value(line: &str) -> JsonlLineResult {
    let input = trim(line);
    if input.is_empty() {
        return JsonlLineResult::Empty;
    }

    let parsed = chunk::parse(input);
    let Some(first) = parsed.values.first() else {
        let message = match parsed.status {
            chunk::Status::NeedMoreData => return JsonlLineResult::Incomplete,
            chunk::Status::Error => FAILED_TO_PARSE_JSONL,
            chunk::Status::Complete => INVALID_JSONL_LINE,
        };
        return JsonlLineResult::Invalid {
            error: syntax_error(message),
        };
    };
    // The chunk parser accepted the text by Bun's rules. What a Rust value
    // cannot hold of it, a number beyond the double range or nesting deeper
    // than 128 levels, is a parse error here.
    let Ok(value) = garcon_js::json::from_str::<Opaque>(&input[first.clone()]) else {
        return JsonlLineResult::Invalid {
            error: syntax_error(FAILED_TO_PARSE_JSONL),
        };
    };
    let has_additional_values = parsed.values.len() > 1;
    let raw = if has_additional_values {
        garcon_js::json::stringify(value.as_value())
    } else {
        trim_end(utf16::slice(input, 0, Some(parsed.read as isize))).to_owned()
    };
    JsonlLineResult::Value {
        value,
        raw,
        discarded_suffix: has_additional_values
            || parsed.status != chunk::Status::Complete
            || parsed.read < utf16::len(input),
    }
}

fn syntax_error(message: &str) -> NamedError {
    NamedError {
        name: "SyntaxError".to_owned(),
        message: message.to_owned(),
        code: None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const COMPLETE: &str = r#"{"nested":{"items":[1,2]},"text":"value"}"#;

    // The value of a `value` result as it crosses the JSON boundary.
    fn written(result: &JsonlLineResult) -> serde_json::Value {
        let JsonlLineResult::Value { value, .. } = result else {
            panic!("expected a value, got {result:?}");
        };
        garcon_js::json::from_slice(&serde_json::to_vec(value).unwrap()).unwrap()
    }

    #[test]
    fn preserves_a_valid_json_value() {
        let result =
            parse_first_jsonl_value("  {\"nested\":{\"items\":[1,2]},\"text\":\"value\"}  ");
        assert!(matches!(
            &result,
            JsonlLineResult::Value { raw, discarded_suffix: false, .. } if raw == COMPLETE
        ));
        assert_eq!(
            written(&result),
            json!({"nested": {"items": [1, 2]}, "text": "value"})
        );
    }

    #[test]
    fn retains_only_the_first_value_from_a_concatenated_physical_line() {
        let first = r#"{"type":"user","uuid":"entry-1","text":"café"}"#;
        let second = r#"{"type":"mode","mode":"normal"}"#;

        let result = parse_first_jsonl_value(&format!("{first}{second}"));

        assert!(matches!(
            &result,
            JsonlLineResult::Value { raw, discarded_suffix: true, .. }
                if raw == r#"{"type":"user","uuid":"entry-1","text":"café"}"#
        ));
        assert_eq!(
            written(&result),
            json!({"type": "user", "uuid": "entry-1", "text": "café"})
        );
    }

    #[test]
    fn discards_third_and_later_values_on_the_same_physical_line() {
        let result = parse_first_jsonl_value(r#"{"value":1}{"value":2}{"value":3}"#);

        assert!(matches!(
            &result,
            JsonlLineResult::Value { raw, discarded_suffix: true, .. } if raw == r#"{"value":1}"#
        ));
        assert_eq!(written(&result), json!({"value": 1}));
    }

    #[test]
    fn does_not_split_delimiter_like_text_inside_a_string() {
        let line = r#"{"text":"before }{ after","escaped":"\"quoted\""}"#;

        let result = parse_first_jsonl_value(line);

        assert!(matches!(
            &result,
            JsonlLineResult::Value { raw, discarded_suffix: false, .. } if raw == line
        ));
        assert_eq!(
            written(&result),
            json!({"text": "before }{ after", "escaped": "\"quoted\""})
        );
    }

    #[test]
    fn retains_a_complete_value_before_a_partial_suffix() {
        let result = parse_first_jsonl_value(r#"{"value":"complete"}{"partial":"#);

        assert!(matches!(
            &result,
            JsonlLineResult::Value { raw, discarded_suffix: true, .. }
                if raw == r#"{"value":"complete"}"#
        ));
        assert_eq!(written(&result), json!({"value": "complete"}));
    }

    #[test]
    fn distinguishes_incomplete_and_malformed_values() {
        assert!(matches!(
            parse_first_jsonl_value("{\"partial\":"),
            JsonlLineResult::Incomplete
        ));
        let JsonlLineResult::Invalid { error } = parse_first_jsonl_value("{bad}") else {
            panic!("expected an invalid line");
        };
        assert_eq!(error.name, "SyntaxError");
    }

    #[test]
    fn returns_empty_for_whitespace_only_input() {
        assert!(matches!(
            parse_first_jsonl_value("  \t  "),
            JsonlLineResult::Empty
        ));
    }
}

/// `Bun.JSONL.parseChunk`, which the original calls: JavaScriptCore's strict
/// JSON lexer and recursive parser driven one value at a time, keeping the
/// positions they keep. Read in the sources Bun 1.4.3 builds from:
/// `BunObject.cpp` `jsFunctionJSONLParseChunk`, and `LiteralParser.cpp`
/// `Lexer::lex`, `lexString`, `lexNumber`, `nextAfterValue`,
/// `parseRecursively`, and `tryStreamingParse`
/// (<https://github.com/oven-sh/WebKit/blob/0c06faadf65bf8e8c8ad3a5a8aca83e1e9ed653f/Source/JavaScriptCore/runtime/LiteralParser.cpp#L2317>).
/// The structure cache never consumes a key here, as in a process that has
/// parsed no JSON before.
mod chunk {
    use std::ops::Range;

    use garcon_js::utf16;

    #[derive(Debug, PartialEq, Eq)]
    pub(super) enum Status {
        Complete,
        NeedMoreData,
        Error,
    }

    pub(super) struct Chunk {
        /// The text of each complete value.
        pub values: Vec<Range<usize>>,
        /// How far the input was read, in UTF-16 code units.
        pub read: usize,
        pub status: Status,
    }

    pub(super) fn parse(input: &str) -> Chunk {
        let mut lexer = Lexer::new(input);
        let mut values = Vec::new();
        let mut read = 0;
        let status = 'parse: {
            lexer.lex();
            loop {
                if lexer.token == Token::End {
                    break 'parse Status::Complete;
                }
                let start = lexer.token_start;
                if !lexer.parse_value() {
                    break 'parse if lexer.at_end() {
                        Status::NeedMoreData
                    } else {
                        Status::Error
                    };
                }
                values.push(start..lexer.value_end);
                read = lexer.position_after_last_token;

                // Exactly one value per line: anything but JSON whitespace
                // between a value and the next newline is an error.
                let input: &[u8] = lexer.input;
                let remaining = &input[read..];
                match remaining.iter().position(|byte| *byte == b'\n') {
                    Some(newline) => {
                        if remaining[..newline]
                            .iter()
                            .any(|byte| !is_json_whitespace(*byte))
                        {
                            break 'parse Status::Error;
                        }
                        lexer.ptr = read + newline + 1;
                        lexer.lex();
                    }
                    None if lexer.token != Token::End => break 'parse Status::Error,
                    None => {}
                }
            }
        };
        Chunk {
            values,
            read: utf16::len(&input[..read]),
            status,
        }
    }

    fn is_json_whitespace(byte: u8) -> bool {
        matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Token {
        LBracket,
        RBracket,
        LBrace,
        RBrace,
        Comma,
        Colon,
        String,
        NumberInt32,
        /// A number with a fraction or an exponent, `true`, `false`, or `null`.
        Literal,
        End,
        /// Every other token, and every token the lexer refuses.
        Other,
    }

    enum Frame {
        ArrayElement,
        ObjectMember,
    }

    enum Entry {
        /// A value whose first token is the current one.
        Value,
        /// A property value, which the parser dispatches on the next character.
        ObjectValue,
        Finish,
    }

    struct Lexer<'a> {
        input: &'a [u8],
        ptr: usize,
        token: Token,
        token_start: usize,
        /// Where the last `lex` began, before the whitespace it skipped.
        position_after_last_token: usize,
        /// Where the value that completed last ends, read before the token after it.
        value_end: usize,
    }

    impl<'a> Lexer<'a> {
        fn new(input: &'a str) -> Self {
            Self {
                input: input.as_bytes(),
                ptr: 0,
                token: Token::Other,
                token_start: 0,
                position_after_last_token: 0,
                value_end: 0,
            }
        }

        fn at_end(&self) -> bool {
            self.ptr >= self.input.len()
        }

        fn byte(&self) -> Option<u8> {
            self.input.get(self.ptr).copied()
        }

        // The first position at or after `at` that holds no digit.
        fn digits_from(&self, at: usize) -> usize {
            let mut end = at;
            while self
                .input
                .get(end)
                .is_some_and(|byte| byte.is_ascii_digit())
            {
                end += 1;
            }
            end
        }

        fn set(&mut self, token: Token) -> Token {
            self.token = token;
            token
        }

        fn advance(&mut self, token: Token) -> Token {
            self.ptr += 1;
            self.set(token)
        }

        fn lex(&mut self) -> Token {
            self.position_after_last_token = self.ptr;
            while self.byte().is_some_and(is_json_whitespace) {
                self.ptr += 1;
            }
            let Some(byte) = self.byte() else {
                self.token = Token::End;
                return Token::End;
            };
            self.token_start = self.ptr;
            match byte {
                b'"' => self.lex_string(),
                b'-' | b'0'..=b'9' => self.lex_number(),
                b't' if self.input[self.ptr..].starts_with(b"true") => {
                    self.ptr += 4;
                    self.set(Token::Literal)
                }
                b'f' if self.input[self.ptr..].starts_with(b"false") => {
                    self.ptr += 5;
                    self.set(Token::Literal)
                }
                b'n' if self.input[self.ptr..].starts_with(b"null") => {
                    self.ptr += 4;
                    self.set(Token::Literal)
                }
                b'$' | b'_' | b'a'..=b'z' | b'A'..=b'Z' => self.lex_identifier(),
                b'[' => self.advance(Token::LBracket),
                b']' => self.advance(Token::RBracket),
                b'{' => self.advance(Token::LBrace),
                b'}' => self.advance(Token::RBrace),
                b',' => self.advance(Token::Comma),
                b':' => self.advance(Token::Colon),
                b'(' | b')' | b';' | b'=' | b'.' => self.advance(Token::Other),
                // A single quote and an unrecognized character leave the position where it is.
                _ => self.set(Token::Other),
            }
        }

        // A letter, digit, underscore, or dollar sign continues an identifier;
        // U+200C and U+200D do only on the wider path.
        fn lex_identifier(&mut self) -> Token {
            while let Some(byte) = self.byte() {
                let joiner = matches!(&self.input[self.ptr..], [0xE2, 0x80, 0x8C | 0x8D, ..]);
                if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$') {
                    self.ptr += 1;
                } else if joiner {
                    self.ptr += 3;
                } else {
                    break;
                }
            }
            self.set(Token::Other)
        }

        // A string ends at its closing quote, or is refused with the position
        // on what ended it: a control character, an invalid escape, or the
        // end of the input.
        fn lex_string(&mut self) -> Token {
            self.ptr += 1;
            loop {
                match self.byte() {
                    None => return self.set(Token::Other),
                    Some(b'"') => {
                        self.ptr += 1;
                        return self.set(Token::String);
                    }
                    Some(b'\\') => {
                        self.ptr += 1;
                        let escape = match self.byte() {
                            Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') => {
                                self.ptr += 1;
                                true
                            }
                            Some(b'u') => {
                                let hex = (1..=4).all(|offset| {
                                    self.input
                                        .get(self.ptr + offset)
                                        .is_some_and(|byte| byte.is_ascii_hexdigit())
                                });
                                if hex {
                                    self.ptr += 5;
                                }
                                hex
                            }
                            _ => false,
                        };
                        if !escape {
                            return self.set(Token::Other);
                        }
                    }
                    Some(byte) if byte < 0x20 => return self.set(Token::Other),
                    Some(_) => self.ptr += 1,
                }
            }
        }

        fn lex_number(&mut self) -> Token {
            if self.byte() == Some(b'-') {
                self.ptr += 1;
            }
            let digits = self.ptr;
            let Some(first) = self.byte().filter(|byte| byte.is_ascii_digit()) else {
                return self.set(Token::Other);
            };
            self.ptr += 1;
            if first != b'0' {
                self.ptr = self.digits_from(self.ptr);
            }
            if self
                .byte()
                .is_none_or(|byte| !matches!(byte, b'.' | b'e' | b'E'))
                && self.ptr - digits <= 9
            {
                return self.set(Token::NumberInt32);
            }

            // `WTF::parseJSONDouble`: the longest JSON number, which an
            // exponent without digits does not extend. A fraction without
            // digits leaves the number refused after the decimal point.
            let mut end = self.ptr;
            if self.byte() == Some(b'.') {
                end = self.digits_from(end + 1);
                if end == self.ptr + 1 {
                    self.ptr = end;
                    return self.set(Token::Other);
                }
            }
            if matches!(self.input.get(end), Some(b'e' | b'E')) {
                let signed = usize::from(matches!(self.input.get(end + 1), Some(b'+' | b'-')));
                let exponent = self.digits_from(end + 1 + signed);
                if exponent != end + 1 + signed {
                    end = exponent;
                }
            }
            self.ptr = end;
            self.set(Token::Literal)
        }

        // The token after a value. A comma or a closing bracket is read
        // without counting as a lexed token.
        fn next_after_value(&mut self) -> Token {
            self.value_end = self.ptr;
            match self.byte() {
                Some(b',') => self.advance(Token::Comma),
                Some(b'}') => self.advance(Token::RBrace),
                Some(b']') => self.advance(Token::RBracket),
                _ => self.lex(),
            }
        }

        fn consume_colon(&mut self) -> bool {
            if self.byte() == Some(b':') {
                self.ptr += 1;
                true
            } else {
                self.lex() == Token::Colon
            }
        }

        fn skip_whitespace_before_key(&mut self) {
            if self.byte().is_some_and(|byte| byte != b'"') {
                while self.byte().is_some_and(is_json_whitespace) {
                    self.ptr += 1;
                }
            }
        }

        // `parsePrimitiveValue`: the current token is the value, and the next
        // one follows it.
        fn parse_primitive_value(&mut self) -> bool {
            if !matches!(
                self.token,
                Token::String | Token::NumberInt32 | Token::Literal
            ) {
                return false;
            }
            self.next_after_value();
            true
        }

        fn parse_value(&mut self) -> bool {
            let mut stack: Vec<Frame> = Vec::new();
            let mut entry = Entry::Value;
            loop {
                match entry {
                    Entry::Value => {
                        if matches!(self.token, Token::LBracket | Token::LBrace) {
                            entry = match self.enter_container(&mut stack) {
                                Ok(entry) => entry,
                                Err(()) => return false,
                            };
                        } else if self.parse_primitive_value() {
                            entry = Entry::Finish;
                        } else {
                            return false;
                        }
                    }
                    Entry::ObjectValue => {
                        // The parser's `parseValue`, which dispatches on the next character.
                        match self.byte() {
                            Some(b'"') => {
                                self.lex_string();
                                if self.token != Token::String {
                                    return false;
                                }
                                self.next_after_value();
                            }
                            Some(b'-' | b'0'..=b'9') => {
                                self.lex_number();
                                if !matches!(self.token, Token::NumberInt32 | Token::Literal) {
                                    return false;
                                }
                                self.next_after_value();
                            }
                            _ => {
                                self.lex();
                                if matches!(self.token, Token::LBracket | Token::LBrace) {
                                    entry = match self.enter_container(&mut stack) {
                                        Ok(entry) => entry,
                                        Err(()) => return false,
                                    };
                                    continue;
                                }
                                if !self.parse_primitive_value() {
                                    return false;
                                }
                            }
                        }
                        entry = Entry::Finish;
                    }
                    Entry::Finish => match stack.pop() {
                        None => return true,
                        Some(Frame::ArrayElement) => {
                            if self.token == Token::Comma {
                                if self.lex() == Token::RBracket {
                                    return false;
                                }
                                stack.push(Frame::ArrayElement);
                                entry = Entry::Value;
                            } else if self.token != Token::RBracket {
                                return false;
                            } else {
                                self.next_after_value();
                            }
                        }
                        Some(Frame::ObjectMember) => {
                            if self.token == Token::Comma {
                                self.skip_whitespace_before_key();
                                if self.lex() != Token::String || !self.consume_colon() {
                                    return false;
                                }
                                stack.push(Frame::ObjectMember);
                                entry = Entry::ObjectValue;
                            } else if self.token != Token::RBrace {
                                return false;
                            } else {
                                self.next_after_value();
                            }
                        }
                    },
                }
            }
        }

        // `parseRecursively` on a `[` or `{` that is the current token: how
        // the first member is entered.
        fn enter_container(&mut self, stack: &mut Vec<Frame>) -> Result<Entry, ()> {
            if self.token == Token::LBracket {
                if self.lex() == Token::RBracket {
                    self.next_after_value();
                    return Ok(Entry::Finish);
                }
                stack.push(Frame::ArrayElement);
                Ok(Entry::Value)
            } else {
                self.skip_whitespace_before_key();
                if self.lex() != Token::String {
                    if self.token != Token::RBrace {
                        return Err(());
                    }
                    self.next_after_value();
                    return Ok(Entry::Finish);
                }
                if !self.consume_colon() {
                    return Err(());
                }
                stack.push(Frame::ObjectMember);
                Ok(Entry::ObjectValue)
            }
        }
    }
}
