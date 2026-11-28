use std::{fs, path::Path, process::Command};

use garcon_chats::carryover::{
    page_codec::{
        CarryOverPageCodecError, decode_carry_over_page, encode_carry_over_pages,
        write_encoded_carry_over_page,
    },
    segment_types::{CarryOverPageDescriptor, parse_carry_over_segment_index},
};
use garcon_contract::chat_types::parse_chat_messages;
use garcon_js::json;
use serde::Deserialize;
use serde_json::json;
use tempfile::tempdir;
use tokio_util::sync::CancellationToken;

const SEGMENT_ID: &str = "12345678-1234-4123-8123-123456789abc";

fn bun(mode: &str, path: &Path) {
    let output = Command::new("bun")
        .args([
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/oracles/carryover-page-codec.ts"
            ),
            mode,
        ])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn descriptors(path: &Path, message_count: usize) -> Vec<CarryOverPageDescriptor> {
    let pages: serde_json::Value = json::from_slice(&fs::read(path).unwrap()).unwrap();
    parse_carry_over_segment_index(
        &json!({
            "version": 1, "messageSchemaVersion": 1, "id": SEGMENT_ID,
            "seedSanitation": "not-applicable", "messageCount": message_count,
            "canonicalMessagesSha256": "0".repeat(64), "pages": pages,
        }),
        Some(SEGMENT_ID),
    )
    .unwrap()
    .pages
}

#[tokio::test]
async fn bun_and_rust_read_each_others_brotli_pages_with_canonical_json_bytes() {
    let bun_dir = tempdir().unwrap();
    bun("write", bun_dir.path());
    let expected = fs::read(bun_dir.path().join("messages.json")).unwrap();
    let canonical = json::from_slice(&expected).unwrap();
    let messages = parse_chat_messages(&canonical).unwrap();
    let mut decoded = Vec::new();
    let original_descriptors =
        descriptors(&bun_dir.path().join("descriptors.json"), messages.len());
    for page in &original_descriptors {
        decoded.extend(
            decode_carry_over_page(&bun_dir.path().join(&page.file), page, None)
                .await
                .unwrap(),
        );
    }
    let encoded = serde_json::to_vec(&decoded).unwrap();
    assert_eq!(encoded.len(), expected.len());
    assert_eq!(
        encoded
            .iter()
            .zip(&expected)
            .position(|(left, right)| left != right),
        None
    );

    let rust_dir = tempdir().unwrap();
    fs::create_dir(rust_dir.path().join("pages")).unwrap();
    let pages = encode_carry_over_pages(messages, None).await.unwrap();
    let mut descriptors = Vec::new();
    for page in pages {
        let path = rust_dir.path().join(&page.descriptor.file);
        write_encoded_carry_over_page(&path, &page).await.unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(
            write_encoded_carry_over_page(&path, &page)
                .await
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::AlreadyExists,
        );
        descriptors.push(page.descriptor);
    }
    println!(
        "Brotli page sizes, Bun then Rust: {:?} / {:?}",
        original_descriptors
            .iter()
            .map(|page| page.compressed_bytes)
            .collect::<Vec<_>>(),
        descriptors
            .iter()
            .map(|page| page.compressed_bytes)
            .collect::<Vec<_>>(),
    );
    fs::write(
        rust_dir.path().join("descriptors.json"),
        serde_json::to_vec(&descriptors).unwrap(),
    )
    .unwrap();
    bun("check", rust_dir.path());
}

#[derive(Deserialize)]
struct BadPage {
    descriptor: BadDescriptor,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BadDescriptor {
    file: String,
    first_sequence: u64,
    message_count: u64,
    uncompressed_bytes: u64,
    compressed_bytes: u64,
    sha256: String,
}

#[tokio::test]
async fn rejects_damaged_pages_and_keeps_io_and_abort_distinct() {
    let dir = tempdir().unwrap();
    bun("write", dir.path());
    let bad: Vec<BadPage> =
        json::from_slice(&fs::read(dir.path().join("bad.json")).unwrap()).unwrap();
    for fixture in bad {
        let BadDescriptor {
            file,
            first_sequence,
            message_count,
            uncompressed_bytes,
            compressed_bytes,
            sha256,
        } = fixture.descriptor;
        let descriptor = CarryOverPageDescriptor {
            file,
            first_sequence,
            message_count,
            uncompressed_bytes,
            compressed_bytes,
            sha256,
        };
        let error = decode_carry_over_page(&dir.path().join(&descriptor.file), &descriptor, None)
            .await
            .unwrap_err();
        assert!(matches!(error, CarryOverPageCodecError::Integrity(_)));
        assert_eq!(error.to_string(), fixture.message);
    }
    let page = descriptors(&dir.path().join("descriptors.json"), 258).remove(0);
    let path = dir.path().join(&page.file);
    for (corrupted, message) in [
        (
            CarryOverPageDescriptor {
                compressed_bytes: page.compressed_bytes + 1,
                ..page.clone()
            },
            "Carryover page compressed size differs from its manifest",
        ),
        (
            CarryOverPageDescriptor {
                uncompressed_bytes: page.uncompressed_bytes - 1,
                ..page.clone()
            },
            "Carryover page expands beyond its declared size",
        ),
        (
            CarryOverPageDescriptor {
                uncompressed_bytes: page.uncompressed_bytes + 1,
                ..page.clone()
            },
            "Carryover page uncompressed size differs from its manifest",
        ),
        (
            CarryOverPageDescriptor {
                sha256: "0".repeat(64),
                ..page.clone()
            },
            "Carryover page checksum mismatch",
        ),
    ] {
        let error = decode_carry_over_page(&path, &corrupted, None)
            .await
            .unwrap_err();
        assert!(matches!(error, CarryOverPageCodecError::Integrity(_)));
        assert_eq!(error.to_string(), message);
    }
    let missing = dir.path().join("missing");
    let error = decode_carry_over_page(&missing, &page, None)
        .await
        .unwrap_err();
    assert!(
        matches!(error, CarryOverPageCodecError::Io(error) if error.kind() == std::io::ErrorKind::NotFound)
    );
    let signal = CancellationToken::new();
    signal.cancel();
    assert!(matches!(
        decode_carry_over_page(&missing, &page, Some(&signal)).await,
        Err(CarryOverPageCodecError::Aborted(_)),
    ));
}
