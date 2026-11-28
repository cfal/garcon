// Copyright 2013 the V8 project authors. All rights reserved.
// Copyright (C) 2005, 2006, 2007, 2008, 2009 Apple Inc. All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions
// are met:
// 1.  Redistributions of source code must retain the above copyright
//     notice, this list of conditions and the following disclaimer.
// 2.  Redistributions in binary form must reproduce the above copyright
//     notice, this list of conditions and the following disclaimer in the
//     documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY APPLE INC. AND ITS CONTRIBUTORS ''AS IS'' AND ANY
// EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL APPLE INC. OR ITS CONTRIBUTORS BE LIABLE FOR ANY
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
// ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

//! Adapts the ISO and legacy token grammar from Bun 1.4.3's WebKit
//! JSDateMath-v8.cpp (0c06faadf65bf8e8c8ad3a5a8aca83e1e9ed653f).

use std::borrow::Cow;

use super::DAY_MS;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Token {
    End,
    Space,
    Digit(i32, usize),
    Symbol(u8),
    Month(i32),
    AmPm(i32),
    Zone(i32, bool),
    TimeSeparator,
    Word,
    Other,
}

impl Token {
    fn sign(self) -> Option<i32> {
        match self {
            Self::Symbol(b'+') => Some(1),
            Self::Symbol(b'-') => Some(-1),
            _ => None,
        }
    }
}

struct Scanner<'a> {
    rest: &'a [u8],
    peek: Token,
}

impl<'a> Scanner<'a> {
    fn new(rest: &'a str) -> Self {
        let mut scanner = Self {
            rest: rest.as_bytes(),
            peek: Token::End,
        };
        scanner.advance();
        scanner
    }

    fn advance(&mut self) -> Token {
        let previous = self.peek;
        self.peek = self.scan();
        previous
    }

    fn take(&mut self, token: Token) -> bool {
        if self.peek == token {
            self.advance();
            true
        } else {
            false
        }
    }

    fn number(&mut self) -> Option<(i32, usize)> {
        if let Token::Digit(value, size) = self.peek {
            self.advance();
            Some((value, size))
        } else {
            None
        }
    }

    fn fixed(&mut self, size: usize, range: std::ops::RangeInclusive<i32>) -> Option<i32> {
        if let Token::Digit(value, width) = self.peek
            && width == size
            && range.contains(&value)
        {
            self.advance();
            Some(value)
        } else {
            None
        }
    }

    fn scan(&mut self) -> Token {
        match self.rest.first().copied() {
            None | Some(0) => Token::End,
            Some(b'0'..=b'9') => {
                let size = self.rest.iter().take_while(|b| b.is_ascii_digit()).count();
                let (digits, rest) = self.rest.split_at(size);
                self.rest = rest;
                let value = digits
                    .iter()
                    .skip_while(|&&b| b == b'0')
                    .take(9)
                    .fold(0, |value, b| value * 10 + i32::from(b - b'0'));
                Token::Digit(value, size)
            }
            Some(b @ (b':' | b'+' | b'-' | b'.' | b')')) => {
                self.rest = &self.rest[1..];
                Token::Symbol(b)
            }
            Some(b'A'..) => {
                let size = self.rest.iter().take_while(|&&b| b >= b'A').count();
                let (word, rest) = self.rest.split_at(size);
                self.rest = rest;
                keyword(word)
            }
            Some(b'(') => {
                let mut depth = 0_usize;
                while let Some((&b, rest)) = self.rest.split_first() {
                    if b == 0 {
                        break;
                    }
                    self.rest = rest;
                    match b {
                        b'(' => depth += 1,
                        b')' => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                Token::Other
            }
            Some(b) => {
                self.rest = &self.rest[1..];
                if b.is_ascii_whitespace() {
                    Token::Space
                } else {
                    Token::Other
                }
            }
        }
    }
}

fn keyword(word: &[u8]) -> Token {
    const MONTHS: [&[u8; 3]; 12] = [
        b"jan", b"feb", b"mar", b"apr", b"may", b"jun", b"jul", b"aug", b"sep", b"oct", b"nov",
        b"dec",
    ];
    if let Some(month) = word.get(..3).and_then(|prefix| {
        MONTHS
            .iter()
            .position(|month| prefix.eq_ignore_ascii_case(*month))
    }) {
        return Token::Month(month as i32 + 1);
    }
    let mut lower = [0; 3];
    if word.len() > lower.len() {
        return Token::Word;
    }
    for (dst, b) in lower.iter_mut().zip(word) {
        *dst = b.to_ascii_lowercase();
    }
    match &lower[..word.len()] {
        b"am" => Token::AmPm(0),
        b"pm" => Token::AmPm(12),
        b"t" => Token::TimeSeparator,
        b"z" => Token::Zone(0, true),
        b"ut" | b"utc" | b"gmt" => Token::Zone(0, false),
        b"edt" => Token::Zone(-4, false),
        b"est" | b"cdt" => Token::Zone(-5, false),
        b"cst" | b"mdt" => Token::Zone(-6, false),
        b"mst" | b"pdt" => Token::Zone(-7, false),
        b"pst" => Token::Zone(-8, false),
        _ => Token::Word,
    }
}

struct Components<const N: usize> {
    values: [i32; N],
    len: usize,
}

impl<const N: usize> Components<N> {
    fn new(default: i32) -> Self {
        Self {
            values: [default; N],
            len: 0,
        }
    }

    fn push(&mut self, value: i32) -> Option<()> {
        *self.values.get_mut(self.len)? = value;
        self.len += 1;
        Some(())
    }

    fn finish(&mut self, value: i32) -> Option<()> {
        self.push(value)?;
        self.len = N;
        Some(())
    }
}

#[derive(Default)]
struct Offset {
    sign: i32,
    hour: i32,
    minute: Option<i32>,
}

impl Offset {
    fn fixed(&mut self, hour: i32) {
        self.sign = if hour < 0 { -1 } else { 1 };
        self.hour = hour.abs();
        self.minute = Some(0);
    }

    fn milliseconds(&self) -> Option<Option<i64>> {
        if self.sign == 0 {
            return Some(None);
        }
        // Bun computes this in unsigned 32-bit arithmetic before its range check.
        let seconds = (self.hour as u32)
            .wrapping_mul(3600)
            .wrapping_add(self.minute.unwrap_or(0) as u32 * 60);
        let seconds = i32::try_from(seconds).ok()?;
        Some(Some(i64::from(seconds) * i64::from(self.sign) * 1000))
    }
}

fn milliseconds(value: i32, digits: usize) -> i32 {
    match digits {
        1 => value * 100,
        2 => value * 10,
        _ => value / 10_i32.pow((digits.min(9) - 3) as u32),
    }
}

/// Reads the ISO prefix. Returns false to continue with the legacy parser at
/// the current token, or None if a time after 'T' is malformed.
fn iso_prefix(
    scan: &mut Scanner<'_>,
    day: &mut Components<3>,
    time: &mut Components<4>,
    offset: &mut Offset,
) -> Option<bool> {
    let year = if let Some(sign) = scan.peek.sign() {
        // A sign in an incomplete ISO prefix is ignored by the legacy parser.
        scan.advance();
        let Some(year) = scan.fixed(6, 0..=999_999) else {
            return Some(false);
        };
        if sign < 0 && year == 0 {
            return Some(false);
        }
        sign * year
    } else if let Some(year) = scan.fixed(4, 0..=9999) {
        year
    } else {
        return Some(false);
    };
    day.push(year)?;
    if scan.take(Token::Symbol(b'-')) {
        let Some(month) = scan.fixed(2, 1..=12) else {
            return Some(false);
        };
        day.push(month)?;
        if scan.take(Token::Symbol(b'-')) {
            let Some(date) = scan.fixed(2, 1..=31) else {
                return Some(false);
            };
            day.push(date)?;
        }
    }
    if !scan.take(Token::TimeSeparator) {
        if scan.peek != Token::End {
            return Some(false);
        }
        offset.fixed(0);
        return Some(true);
    }
    let hour = scan.fixed(2, 0..=24)?;
    time.push(hour)?;
    let max_minute = if hour == 24 { 0 } else { 59 };
    scan.take(Token::Symbol(b':')).then_some(())?;
    time.push(scan.fixed(2, 0..=max_minute)?)?;
    if scan.take(Token::Symbol(b':')) {
        time.push(scan.fixed(2, 0..=max_minute)?)?;
        if scan.take(Token::Symbol(b'.')) {
            let (value, digits) = scan.number()?;
            if hour == 24 && value != 0 {
                return None;
            }
            time.push(milliseconds(value, digits))?;
        }
    }
    if scan.take(Token::Zone(0, true)) {
        offset.fixed(0);
    } else if let Some(sign) = scan.peek.sign() {
        scan.advance();
        let (hour, minute) = if let Some(hhmm) = scan.fixed(4, 0..=9999) {
            (hhmm / 100, hhmm % 100)
        } else {
            let hour = scan.fixed(2, 0..=23)?;
            scan.take(Token::Symbol(b':')).then_some(())?;
            (hour, scan.fixed(2, 0..=59)?)
        };
        if hour > 23 || minute > 59 {
            return None;
        }
        *offset = Offset {
            sign,
            hour,
            minute: Some(minute),
        };
    }
    (scan.peek == Token::End).then_some(true)
}

fn legacy(
    scan: &mut Scanner<'_>,
    day: &mut Components<3>,
    time: &mut Components<4>,
    offset: &mut Offset,
) -> Option<(Option<i32>, i32)> {
    let mut has_number = day.len != 0;
    let (mut named_month, mut hour_offset) = (None, None);
    while scan.peek != Token::End {
        match scan.advance() {
            Token::Digit(value, _) => {
                has_number = true;
                let expecting_time = match time.len {
                    1 | 2 => value <= 59,
                    3 => value <= 999,
                    _ => false,
                };
                if scan.take(Token::Symbol(b':')) {
                    if scan.take(Token::Symbol(b':')) {
                        if time.len != 0 {
                            return None;
                        }
                        time.push(value)?;
                        time.push(0)?;
                    } else {
                        time.push(value)?;
                        scan.take(Token::Symbol(b'.'));
                    }
                } else if scan.take(Token::Symbol(b'.')) && expecting_time {
                    time.push(value)?;
                    let (value, digits) = scan.number()?;
                    // The original ignores AddFinal's result for this branch.
                    let _ = time.finish(milliseconds(value, digits));
                } else if offset.sign != 0 && offset.minute.is_none() && value <= 59 {
                    offset.minute = Some(value);
                } else if expecting_time {
                    time.finish(value)?;
                    if !matches!(scan.peek, Token::End | Token::Space | Token::Zone(0, true))
                        && scan.peek.sign().is_none()
                    {
                        return None;
                    }
                } else {
                    day.push(value)?;
                    scan.take(Token::Symbol(b'-'));
                }
            }
            Token::Month(month) => {
                named_month = Some(month);
                scan.take(Token::Symbol(b'-'));
            }
            Token::AmPm(hours) if time.len != 0 => hour_offset = Some(hours),
            Token::Zone(hour, _) if has_number => offset.fixed(hour),
            Token::Word | Token::TimeSeparator | Token::AmPm(_) | Token::Zone(_, _) => {
                if has_number || matches!(scan.peek, Token::Digit(_, _)) {
                    return None;
                }
            }
            token
                if token.sign().is_some()
                    && ((offset.hour == 0 && offset.minute == Some(0)) || time.len != 0) =>
            {
                let (value, digits) = scan.number().unwrap_or((0, 0));
                has_number = true;
                let (hour, minute) = if scan.peek == Token::Symbol(b':') {
                    (value, None)
                } else {
                    match digits {
                        1 | 2 => (value, Some(0)),
                        3 | 4 => (value / 100, Some(value % 100)),
                        _ => return None,
                    }
                };
                *offset = Offset {
                    sign: token.sign()?,
                    hour,
                    minute,
                };
            }
            Token::Symbol(b'+' | b'-' | b')') if has_number => return None,
            _ => {}
        }
    }
    let hour = time.values[0];
    let hour = if let Some(offset) = hour_offset {
        if hour > 12 {
            return None;
        }
        hour % 12 + offset
    } else {
        hour
    };
    Some((named_month, hour))
}

fn fold_whitespace(text: &str) -> Cow<'_, str> {
    if text.is_ascii() {
        return Cow::Borrowed(text);
    }
    let wide = text.chars().any(|c| c > '\u{ff}');
    Cow::Owned(
        text.chars()
            .map(|c| match c {
                '\u{b}' if wide => ' ',
                '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200a}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}' => ' ',
                _ => c,
            })
            .collect(),
    )
}

/// Returns the milliseconds treating the components as UTC, and the parsed
/// offset (None means use the process's local zone).
pub(super) fn parse(text: &str) -> Option<(i64, Option<i64>)> {
    let text = fold_whitespace(text);
    let mut scan = Scanner::new(&text);
    let mut day = Components::new(1);
    let mut time = Components::new(0);
    let mut offset = Offset::default();
    let iso = iso_prefix(&mut scan, &mut day, &mut time, &mut offset)?;
    let (named_month, hour) = if iso {
        (None, time.values[0])
    } else {
        legacy(&mut scan, &mut day, &mut time, &mut offset)?
    };
    if day.len == 0 {
        return None;
    }
    let [a, b, c] = day.values;
    let (mut year, month, day) = match named_month {
        Some(month) if (1..=31).contains(&a) => (b, month, a),
        Some(month) => (a, month, b),
        None if iso || !(1..=31).contains(&a) => (a, b, c),
        None => (c, a, b),
    };
    if !iso {
        year += match year {
            0..=49 => 2000,
            50..=99 => 1900,
            _ => 0,
        };
    }
    let [_, minute, second, millis] = time.values;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || minute > 59
        || second > 59
        || millis > 999
        || hour > 24
        || (hour == 24 && (minute != 0 || second != 0 || millis != 0))
    {
        return None;
    }
    let days = days_from_civil(i64::from(year), i64::from(month), i64::from(day));
    let within_day = ((hour * 60 + minute) * 60 + second) * 1000 + millis;
    let unadjusted = days
        .checked_mul(DAY_MS)?
        .checked_add(i64::from(within_day))?;
    Some((unadjusted, offset.milliseconds()?))
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let month_index = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    era * 146_097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year - 719_468
}
