use super::*;

use std::path::Path;
use std::process::Command;

use serde::Deserialize;

#[derive(Deserialize)]
struct Oracle {
    dates: Vec<(String, Option<i64>)>,
    local: Vec<(i64, Option<[i64; 9]>)>,
    intl: Vec<(String, IntlOracle)>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum IntlOracle {
    Accepted { days: Vec<IntlDay> },
    Rejected { error: [String; 2] },
}

#[derive(Deserialize)]
#[serde(untagged)]
enum IntlDay {
    Day { day: String },
    Rejected { error: [String; 2] },
}

#[test]
fn dates_and_time_zones_match_bun_in_separate_processes() {
    let binary = std::env::current_exe().unwrap();
    for zone in [
        "UTC",
        "America/New_York",
        "Asia/Kolkata",
        "Pacific/Auckland",
        "Africa/Monrovia",
        ":America/New_York",
        "america/new_york",
        "PST",
        "pst",
        "pSt",
        "IST",
        "ist",
        "iSt",
        "est",
        "cet",
        "Unrecognized/Zone",
    ] {
        let output = Command::new(&binary)
            .args([
                "--exact",
                "date_parse::tests::check_current_zone",
                "--nocapture",
            ])
            .env("TZ", zone)
            .env("GARCON_DATE_ORACLE", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "TZ={zone}:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        eprintln!(
            "TZ={zone}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
}

#[test]
fn check_current_zone() {
    // This entry point runs once per TZ in a fresh process, not through set_var.
    if std::env::var_os("GARCON_DATE_ORACLE").is_none() {
        return;
    }
    let output = Command::new("bun")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/date_oracle.ts"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Oracle = crate::json::from_slice(&output.stdout).unwrap();
    let mut failures = Vec::new();
    let mut pass = 0;
    for (text, expected) in oracle.dates {
        let actual = date_parse(&text);
        if actual == expected {
            pass += 1;
        } else {
            failures.push(format!("Date.parse({text:?}): {actual:?} != {expected:?}"));
        }
    }
    for (time, expected) in &oracle.local {
        let actual = local_calendar_fields(*time).map(|fields| {
            [
                fields.year,
                fields.month.into(),
                fields.day.into(),
                fields.weekday.into(),
                fields.hour.into(),
                fields.minute.into(),
                fields.second.into(),
                fields.millisecond.into(),
                fields.timezone_offset.into(),
            ]
        });
        if actual == *expected {
            pass += 1;
        } else {
            failures.push(format!(
                "Date({time}) local fields: {actual:?} != {expected:?}"
            ));
        }
    }
    for (name, oracle_zone) in oracle.intl {
        match (IntlTimeZone::parse(&name), oracle_zone) {
            (Ok(zone), IntlOracle::Accepted { days }) => {
                pass += 1;
                assert_eq!(days.len(), oracle.local.len());
                for ((time, _), expected) in oracle.local.iter().zip(days) {
                    let actual = zone.calendar_day(*time);
                    match (actual, expected) {
                        (Ok(actual), IntlDay::Day { day }) if actual.to_string() == day => {
                            pass += 1
                        }
                        (Err(actual), IntlDay::Rejected { error })
                            if error == ["RangeError", actual.to_string().as_str()] =>
                        {
                            pass += 1
                        }
                        (actual, IntlDay::Day { day }) => {
                            failures.push(format!(
                                "Intl zone {name:?} at {time}: {actual:?} != {day:?}"
                            ));
                        }
                        (actual, IntlDay::Rejected { error }) => {
                            failures.push(format!(
                                "Intl zone {name:?} at {time}: {actual:?} != {error:?}"
                            ));
                        }
                    }
                }
            }
            (Err(actual), IntlOracle::Rejected { error })
                if error == ["RangeError", actual.to_string().as_str()] =>
            {
                pass += 1
            }
            (actual, IntlOracle::Accepted { .. }) => {
                failures.push(format!("Intl zone {name:?}: {actual:?} != accepted"));
            }
            (actual, IntlOracle::Rejected { error }) => {
                failures.push(format!("Intl zone {name:?}: {actual:?} != {error:?}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "matched {pass}/{}:\n{}",
        pass + failures.len(),
        failures.join("\n")
    );
    eprintln!("Date and Intl matched {pass}/{pass}");
}
