use std::{path::Path, process::Command};

use garcon_js::unicode;

fn run_bun_oracle(script: &str) -> Vec<u8> {
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join(script);
    let output = Command::new("bun")
        .arg(script)
        .output()
        .expect("run Bun Unicode oracle");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

#[test]
fn unicode_property_classes_match_bun_for_every_scalar() {
    let data = run_bun_oracle("unicode-oracle.ts");
    assert_eq!(data.len(), 0x11_0000);
    for (code, expected) in data.into_iter().enumerate() {
        let Some(character) = char::from_u32(code as u32) else {
            continue;
        };
        let category = unicode::category(character);
        let actual = u8::from(category.is_letter())
            | (u8::from(category.is_number()) << 1)
            | (u8::from(category.is_mark()) << 2)
            | (u8::from(category.is_format()) << 3)
            | (u8::from(unicode::is_white_space(character)) << 4);
        assert_eq!(actual, expected, "U+{code:04X}");
    }
}

#[test]
fn rust_lowercase_matches_bun_across_unicode() {
    let data = run_bun_oracle("lowercase-oracle.ts");
    let (contexts, changed) = data.split_at(0x11_0000);
    let changed: Vec<(usize, String)> = garcon_js::json::from_slice(changed).unwrap();
    let mut changed = changed.into_iter().peekable();
    let mut scalar_mismatches = 0;
    let mut contextual_mismatches = 0;
    let mut examples = Vec::new();
    let final_sigma = '\u{03c2}';
    for (code, &expected_context) in contexts.iter().enumerate() {
        let Some(character) = char::from_u32(code as u32) else {
            continue;
        };
        let original = character.to_string();
        let expected = changed
            .next_if(|(point, _)| *point == code)
            .map_or_else(|| original.clone(), |(_, mapped)| mapped);
        let actual = original.to_lowercase();
        if actual != expected {
            scalar_mismatches += 1;
            if examples.len() < 16 {
                examples.push(format!("U+{code:04X}: Bun {expected:?}, Rust {actual:?}"));
            }
        }

        let before = format!("A\u{03a3}{character}").to_lowercase();
        let before_with_cased_suffix = format!("A\u{03a3}{character}A").to_lowercase();
        let after = format!("{character}\u{03a3}").to_lowercase();
        let after_with_cased_prefix = format!("A{character}\u{03a3}").to_lowercase();
        let actual_context = u8::from(before.chars().nth(1) == Some(final_sigma))
            | (u8::from(before_with_cased_suffix.chars().nth(1) == Some(final_sigma)) << 1)
            | (u8::from(after.ends_with(final_sigma)) << 2)
            | (u8::from(after_with_cased_prefix.ends_with(final_sigma)) << 3);
        if actual_context != expected_context {
            contextual_mismatches += 1;
            if examples.len() < 16 {
                examples.push(format!("U+{code:04X} final sigma: Bun {expected_context:04b}, Rust {actual_context:04b}"));
            }
        }
    }
    assert!(changed.next().is_none());
    assert!(
        scalar_mismatches == 0 && contextual_mismatches == 0,
        "{scalar_mismatches} scalar and {contextual_mismatches} final-sigma mismatches:\n{}",
        examples.join("\n"),
    );
}
