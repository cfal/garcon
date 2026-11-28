#[test]
fn ownership_does_not_add_boolean_methods_or_read_provider_running_state() {
    let source = include_str!("../src/execution_ownership.rs");
    let implementation = source.split_once("impl ExecutionOwnership {").unwrap().1;
    let mut methods: Vec<_> = implementation
        .split("pub fn ")
        .skip(1)
        .map(|method| method.split_once('{').unwrap().0)
        .filter(|signature| signature.trim_end().ends_with("-> bool"))
        .map(|signature| signature.split_once('(').unwrap().0)
        .collect();
    methods.sort_unstable();
    assert_eq!(
        methods,
        [
            "has_any_owner",
            "has_attempt",
            "has_direct",
            "has_drain_request",
            "has_owner",
            "has_suppression",
            "has_transcript_snapshot",
            "is_current_attempt",
            "is_direct_current",
            "is_draining",
            "is_turn_reserved",
            "remove_attempt",
            "retire_attempt",
        ]
    );
    assert!(!implementation.contains("is_chat_running("));
}
