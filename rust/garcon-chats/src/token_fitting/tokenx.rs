//! The default estimator from tokenx 2.1.1, used by `budget.ts`.

use std::{collections::HashMap, sync::LazyLock};

use garcon_js::{
    trim,
    unicode::{is_emoji_component, is_extended_pictographic},
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Segment {
    Space,
    Punctuation,
    Text,
}

pub fn estimate_handoff_tokens(text: &str) -> usize {
    estimate(text.chars())
}

pub fn estimate_handoff_tokens_utf16(units: &[u16]) -> usize {
    // An unpaired surrogate and U+FFFD both occupy one unit and match none
    // of the delimiter, language, emoji, or CJK classes.
    estimate(
        char::decode_utf16(units.iter().copied())
            .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER)),
    )
}

fn estimate(characters: impl Iterator<Item = char>) -> usize {
    let mut total = 0;
    let mut kind = Segment::Space;
    let mut preceding = None;
    let mut current = Count::new();
    for character in characters {
        let next = classify(character);
        if kind != next {
            if current.scalars != 0 {
                total += current.tokens(kind, preceding);
                preceding = Some(kind);
            }
            kind = next;
            current = Count::new();
        }
        current.push(kind, character);
    }
    total + current.tokens(kind, preceding)
}

fn classify(character: char) -> Segment {
    if character.is_ascii() {
        let byte = character as u8;
        if matches!(byte, b'\t'..=b'\r' | b' ') {
            Segment::Space
        } else if b".,!?;(){}[]<>:/\\|@#$%^&*+=`~_\"-".contains(&byte) {
            Segment::Punctuation
        } else {
            Segment::Text
        }
    } else if trim(character.encode_utf8(&mut [0; 4])).is_empty() {
        Segment::Space
    } else {
        Segment::Text
    }
}

const LANGUAGE_FACTORS: [f64; 5] = [3.0, 4.5, 2.5, 6.0, 3.0];

static LANGUAGE_FORMS: LazyLock<HashMap<char, usize>> = LazyLock::new(|| {
    let mut forms = HashMap::new();
    let sets = [
        "\u{e4}\u{f6}\u{fc}\u{df}\u{1e9e}",
        "\u{e9}\u{e8}\u{ea}\u{eb}\u{e0}\u{e2}\u{ee}\u{ef}\u{f4}\u{fb}\u{f9}\u{fc}\u{ff}\u{e7}\u{153}\u{e6}\u{e1}\u{ed}\u{f3}\u{fa}\u{f1}",
        "\u{105}\u{107}\u{119}\u{142}\u{144}\u{f3}\u{15b}\u{17a}\u{17c}\u{11b}\u{161}\u{10d}\u{159}\u{17e}\u{fd}\u{16f}\u{fa}\u{10f}\u{165}\u{148}",
    ];
    for (index, set) in sets.into_iter().enumerate() {
        for character in set.chars() {
            forms.entry(canonicalize(character)).or_insert(index);
        }
    }
    for character in '\u{430}'..='\u{44f}' {
        forms.entry(canonicalize(character)).or_insert(3);
    }
    forms.entry(canonicalize('\u{451}')).or_insert(3);
    for character in '\u{3ac}'..='\u{3ce}' {
        forms.entry(canonicalize(character)).or_insert(4);
    }
    forms
});

fn canonicalize(character: char) -> char {
    // Legacy RegExp ignore-case folds one UTF-16 unit and never folds a
    // non-ASCII unit to ASCII.
    if character.len_utf16() != 1 {
        return character;
    }
    let mut upper = character.to_uppercase();
    match upper.next() {
        Some(value) if !value.is_ascii() && value.len_utf16() == 1 && upper.next().is_none() => {
            value
        }
        _ => character,
    }
}

struct Count {
    scalars: usize,
    units: usize,
    newline: bool,
    structured_whitespace: bool,
    digits: bool,
    lowercase: bool,
    language: usize,
    emoji: bool,
    cjk: bool,
    kana: usize,
    hangul: usize,
}

impl Count {
    const fn new() -> Self {
        Self {
            scalars: 0,
            units: 0,
            newline: false,
            structured_whitespace: false,
            digits: true,
            lowercase: true,
            language: LANGUAGE_FACTORS.len(),
            emoji: true,
            cjk: false,
            kana: 0,
            hangul: 0,
        }
    }

    fn push(&mut self, kind: Segment, character: char) {
        self.scalars += 1;
        match kind {
            Segment::Space => {
                self.structured_whitespace |= self.newline;
                self.newline |= character == '\n';
            }
            Segment::Punctuation => (),
            Segment::Text => {
                self.units += character.len_utf16();
                self.digits &= character.is_ascii_digit();
                self.lowercase &= character.is_ascii_lowercase();
                if character.is_ascii() {
                    self.emoji &= self.scalars != 1 && character.is_ascii_digit();
                    return;
                }
                if self.language != 0
                    && let Some(&language) = LANGUAGE_FORMS.get(&canonicalize(character))
                {
                    self.language = self.language.min(language);
                }
                self.emoji = self.emoji
                    && (is_extended_pictographic(character)
                        || self.scalars != 1 && is_emoji_component(character));
                self.cjk |= cjk_trigger(character);
                self.kana += usize::from(matches!(character as u32, 0x3040..=0x30ff));
                self.hangul += usize::from(is_hangul(character));
            }
        }
    }

    fn tokens(&self, kind: Segment, previous: Option<Segment>) -> usize {
        match kind {
            Segment::Space => usize::from(
                self.structured_whitespace
                    || self.newline && previous != Some(Segment::Punctuation),
            ),
            Segment::Punctuation => self.scalars.div_ceil(6),
            Segment::Text if self.language < LANGUAGE_FACTORS.len() => {
                (self.scalars as f64 / LANGUAGE_FACTORS[self.language]).ceil() as usize
            }
            Segment::Text if self.emoji => (self.scalars as f64 / 0.9).ceil() as usize,
            Segment::Text if self.cjk => {
                let hanzi = self.scalars - self.kana - self.hangul;
                (hanzi as f64 / 1.15 + self.kana as f64 / 1.4 + self.hangul as f64 / 1.65).ceil()
                    as usize
            }
            Segment::Text if self.digits => self.units.div_ceil(3),
            Segment::Text if self.units <= 3 || self.units <= 8 && self.lowercase => 1,
            Segment::Text => self.units.div_ceil(7),
        }
    }
}

fn cjk_trigger(character: char) -> bool {
    matches!(character as u32,
        0x4e00..=0x9fff | 0x3400..=0x4dbf | 0x3000..=0x30ff | 0xff00..=0xffef |
        0x2e80..=0x2eff | 0x31c0..=0x31ef | 0x3200..=0x32ff | 0x3300..=0x33ff
    ) || is_hangul(character)
}

fn is_hangul(character: char) -> bool {
    matches!(character as u32, 0xac00..=0xd7af | 0x1100..=0x11ff | 0x3130..=0x318f | 0xa960..=0xa97f | 0xd7b0..=0xd7ff)
}
