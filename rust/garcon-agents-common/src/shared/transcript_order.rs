pub fn compare_transcript_timestamps(left: f64, right: f64) -> f64 {
    match (left > 0.0, right > 0.0) {
        (true, false) => -1.0,
        (false, true) => 1.0,
        (true, true) if left != right => left - right,
        _ => 0.0,
    }
}
