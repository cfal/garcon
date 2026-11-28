use std::{path::Path, process::Command};

use garcon_js::{Number, json::from_slice};
use garcon_ledger::{
    codec::{StoredLedgerRow, decode_stored_ledger_row, encode_ledger_draft},
    contracts::{LedgerPermissionLifecycle, LedgerRowData, LedgerRowDraft},
};
use rusqlite::{Connection, params};

fn bun(operation: &str, root: &Path) -> Vec<u8> {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/codec_store_oracle.ts"
        ))
        .arg(operation)
        .arg(root)
        .output()
        .expect("start Bun store oracle");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .trim_end()
        .as_bytes()
        .to_owned()
}

#[test]
fn tlv5_perm_03_store_reopen_01_durable_incarnation_round_trips_through_bun() {
    let root = tempfile::tempdir().unwrap();
    let expected = bun("write", root.path());
    let database_path = root.path().join("synthetic-chat").join("ledger.sqlite");
    let database = Connection::open(&database_path).unwrap();
    assert_eq!(rusqlite::version(), "3.54.1");
    let stored = database
        .prepare("SELECT view_id, ordinal, kind, at, client_message_id, payload_json FROM transcript_rows ORDER BY ordinal")
        .unwrap()
        .query_map([], |row| {
            Ok(StoredLedgerRow {
                view_id: row.get(0)?,
                ordinal: Number(row.get::<_, i64>(1)? as f64),
                kind: row.get(2)?,
                at: row.get(3)?,
                client_message_id: row.get(4)?,
                payload_json: row.get(5)?,
            })
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(stored.len(), 3);
    let mut decoded = stored
        .iter()
        .map(decode_stored_ledger_row)
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        serde_json::to_vec(&decoded).unwrap(),
        expected,
        "Bun store to Rust codec"
    );
    for (stored, decoded) in stored.iter().zip(&decoded) {
        let encoded = encode_ledger_draft(&LedgerRowDraft {
            at: decoded.at.clone(),
            provider_meta: decoded.provider_meta.clone(),
            data: decoded.data.clone(),
        })
        .unwrap();
        assert_eq!(encoded.payload_json, stored.payload_json);
        assert_eq!(encoded.client_message_id, stored.client_message_id);
    }
    let mut new_row = decoded[0].clone();
    new_row.ordinal = 4;
    let LedgerRowData::PermissionRequested {
        lifecycle:
            LedgerPermissionLifecycle::Requested {
                permission_occurrence_id,
                ..
            },
    } = &mut new_row.data
    else {
        panic!("Bun must reopen the requested occurrence");
    };
    *permission_occurrence_id = "22222222-2222-4222-8222-222222222222".into();
    let encoded = encode_ledger_draft(&LedgerRowDraft {
        at: new_row.at.clone(),
        provider_meta: new_row.provider_meta.clone(),
        data: new_row.data.clone(),
    })
    .unwrap();
    let mut value: serde_json::Value = from_slice(encoded.payload_json.as_bytes()).unwrap();
    let fields = value["value"].as_object_mut().unwrap();
    assert_eq!(
        fields.get("incarnation").unwrap(),
        "22222222-2222-4222-8222-222222222222"
    );
    assert!(!fields.contains_key("permissionOccurrenceId"));
    fields.insert("requestId".into(), "old-native-request".into());
    database.execute(
        "INSERT INTO transcript_rows(view_id, ordinal, kind, at, client_message_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
        params![new_row.view_id.as_str(), i64::try_from(new_row.ordinal).unwrap(), new_row.data.kind(), new_row.at,
            encoded.client_message_id, garcon_js::json::stringify(&value)],
    ).unwrap();
    database.close().unwrap();
    decoded.push(new_row);
    assert_eq!(
        bun("read", root.path()),
        serde_json::to_vec(&decoded).unwrap(),
        "Rust codec to Bun store"
    );
}
