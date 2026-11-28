use std::{path::Path, process::Command};

pub fn bun_fixtures(script: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/interface_cases")
        .join(script);
    let result = Command::new("bun").arg(path).output().unwrap();
    assert!(
        result.status.success(),
        "{script}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}
