use std::{path::Path, process::Command};

use garcon_js::unicode;

#[test]
fn unicode_property_classes_match_bun_for_every_scalar() {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/unicode-oracle.ts");
    let output = Command::new("bun")
        .arg(script)
        .output()
        .expect("run Bun Unicode oracle");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout.len(), 0x11_0000);
    for (code, expected) in output.stdout.into_iter().enumerate() {
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
