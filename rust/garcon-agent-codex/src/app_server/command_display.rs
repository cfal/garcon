use std::borrow::Cow;

use garcon_js::unicode::is_white_space;

pub fn normalize_codex_command_display(command: &str) -> Cow<'_, str> {
    if !has_balanced_posix_quoting(command) {
        return Cow::Borrowed(command);
    }
    shell_words(command)
        .and_then(unwrap_codex_shell_command)
        .map_or(Cow::Borrowed(command), Cow::Owned)
}

fn unwrap_codex_shell_command(mut argv: Vec<String>) -> Option<String> {
    // Mirrors Codex's wrapper argv: https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/core/src/shell.rs#L24-L50
    let shell = argv.first()?.rsplit(['/', '\\']).next()?.to_lowercase();
    let shell = shell.strip_suffix(".exe").unwrap_or(&shell);
    let unwrap = match argv.as_slice() {
        [_, flag, _] => match shell {
            "bash" | "sh" | "zsh" => matches!(flag.as_str(), "-c" | "-lc"),
            "powershell" | "pwsh" => flag.eq_ignore_ascii_case("-command"),
            "cmd" => flag.eq_ignore_ascii_case("/c"),
            _ => false,
        },
        [_, profile, flag, _] => {
            matches!(shell, "powershell" | "pwsh")
                && profile.eq_ignore_ascii_case("-noprofile")
                && flag.eq_ignore_ascii_case("-command")
        }
        _ => false,
    };
    if unwrap { argv.pop() } else { None }
}

fn has_balanced_posix_quoting(command: &str) -> bool {
    let mut quote = None;
    let mut chars = command.chars();
    while let Some(ch) = chars.next() {
        match (quote, ch) {
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('\''), _) => {}
            (_, '\\') if chars.next().is_none() => return false,
            (None, '\'' | '"') => quote = Some(ch),
            _ => {}
        }
    }
    quote.is_none()
}

fn is_control(ch: char) -> bool {
    matches!(ch, '|' | '&' | ';' | '(' | ')' | '<' | '>')
}

fn quoted_end(chars: &[char], start: usize, quote: char, escapes: bool) -> Option<usize> {
    let mut i = start + 1;
    while let Some(&ch) = chars.get(i) {
        if ch == quote {
            return Some(i);
        }
        i += if escapes && ch == '\\' { 2 } else { 1 };
    }
    None
}

fn ansi_end(chars: &[char], start: usize) -> Option<usize> {
    (chars.get(start..start + 2) == Some(&['$', '\'']))
        .then(|| quoted_end(chars, start + 1, '\'', true))
        .flatten()
}

fn shell_words(command: &str) -> Option<Vec<String>> {
    let chars: Vec<_> = command.chars().collect();
    let mut words = Vec::new();
    let mut i = 0;
    // shell-quote finds adjacent quote/bareword chunks before scanning each word.
    while let Some(&ch) = chars.get(i) {
        if is_control(ch) {
            return None;
        }
        let start = i;
        while let Some(&ch) = chars.get(i) {
            i = match ch {
                '\\' if chars.get(i + 1).is_some_and(|&next| {
                    matches!(next, '\'' | '"' | '$' | '\\' | ' ' | '\t') || is_control(next)
                }) =>
                {
                    i + 2
                }
                '\'' | '"' => match quoted_end(&chars, i, ch, ch == '"') {
                    Some(end) => end + 1,
                    None => break,
                },
                '$' if chars.get(i + 1) == Some(&'$') => i + 2,
                '$' => ansi_end(&chars, i).map_or(i + 1, |end| end + 1),
                _ if is_control(ch) || is_white_space(ch) => break,
                _ => i + 1,
            };
        }
        if i == start {
            i += 1;
        } else {
            words.push(shell_word(&chars[start..i])?);
        }
    }
    Some(words)
}

fn shell_word(chars: &[char]) -> Option<String> {
    let mut word = String::new();
    let mut quote = None;
    let mut i = 0;
    while let Some(&ch) = chars.get(i) {
        i += 1;
        match (quote, ch) {
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('\''), _) => word.push(ch),
            (None, '\'' | '"') => quote = Some(ch),
            (None, '\\') => {
                if let Some(&next) = chars.get(i) {
                    if matches!(next, '*' | '?') {
                        return None;
                    }
                    word.push(next);
                    i += 1;
                }
            }
            (Some('"'), '\\') => {
                let next = *chars.get(i)?;
                if !matches!(next, '"' | '\\' | '$') {
                    word.push('\\');
                }
                word.push(next);
                i += 1;
            }
            (None, '$') if let Some(end) = ansi_end(chars, i - 1) => {
                word.push_str(&expand_ansi_c(&chars[i + 1..end]));
                i = end + 1;
            }
            (_, '$') | (None, '#' | '*' | '?') => return None,
            _ => word.push(ch),
        }
    }
    Some(word)
}

fn expand_ansi_c(chars: &[char]) -> String {
    let mut units = Vec::new();
    let mut i = 0;
    while let Some(&ch) = chars.get(i) {
        if ch == '\\'
            && let Some((escaped, used)) = ansi_escape(&chars[i + 1..])
        {
            units.extend(escaped);
            i += used + 1;
        } else {
            units.extend(ch.encode_utf16(&mut [0; 2]).iter().copied());
            i += 1;
        }
    }
    String::from_utf16_lossy(units.split(|&unit| unit == 0).next().unwrap_or_default())
}

fn ansi_escape(chars: &[char]) -> Option<(Vec<u16>, usize)> {
    let kind = *chars.first()?;
    let (digit_start, limit, radix) = match kind {
        'c' => {
            let ctrl = *chars.get(1)?;
            let used = if chars.get(1..3) == Some(&['\\', '\\']) {
                3
            } else {
                2
            };
            let code = if ctrl == '?' {
                0x7f
            } else {
                ctrl.encode_utf16(&mut [0; 2])[0] & 0x1f
            };
            return Some((vec![code], used));
        }
        'a' | 'b' | 'e' | 'E' | 'f' | 'n' | 'r' | 't' | 'v' | '\\' | '\'' | '"' | '?' => {
            let code = match kind {
                'a' => 0x07,
                'b' => 0x08,
                'e' | 'E' => 0x1b,
                'f' => 0x0c,
                'n' => 0x0a,
                'r' => 0x0d,
                't' => 0x09,
                'v' => 0x0b,
                _ => kind as u16,
            };
            return Some((vec![code], 1));
        }
        '0'..='7' => (0, 3, 8),
        'x' => (1, 2, 16),
        'u' => (1, 4, 16),
        'U' => (1, 8, 16),
        _ => return None,
    };
    let mut value = 0;
    let mut used = digit_start;
    for digit in chars[digit_start..].iter().take(limit) {
        let Some(digit) = digit.to_digit(radix) else {
            break;
        };
        value = value * radix + digit;
        used += 1;
    }
    if used == digit_start || value > 0x10ffff {
        return None;
    }
    let units = if radix == 8 {
        vec![(value & 0xff) as u16]
    } else if value > 0xffff {
        vec![
            (0xd7c0 + (value >> 10)) as u16,
            (0xdc00 + (value & 0x3ff)) as u16,
        ]
    } else {
        vec![value as u16]
    };
    Some((units, used))
}
