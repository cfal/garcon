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
const FACETS: [&str; 2] = ["ChatExecutionCommands", "ChatExecutionQueries"];
const ALLOWED_EXECUTION_PREDICATES: [&str; 3] = [
    "owns_execution",
    "is_chat_turn_reserved",
    "is_chat_stop_in_flight",
];

fn predicates_in(facet: &str) -> Vec<&'static str> {
    let source = include_str!("../src/types.rs");
    let body = source
        .split_once(&format!("pub trait {facet} {{"))
        .unwrap()
        .1;
    let body = body.split_once("\n}").unwrap().0;
    body.split("    fn ")
        .skip(1)
        .filter_map(|signature| {
            let (name, rest) = signature.split_once('(')?;
            let (parameters, _) = rest.split_once("-> bool;")?;
            let parameters = parameters.split_whitespace().collect::<String>();
            let (parameter, kind) = parameters.strip_prefix("&self,")?.split_once(':')?;
            (matches!(parameter, "chat" | "chat_id") && kind == "&str)").then_some(name)
        })
        .collect()
}

#[test]
fn exposes_only_sanctioned_busy_questions() {
    for facet in FACETS {
        for predicate in predicates_in(facet) {
            assert!(
                ALLOWED_EXECUTION_PREDICATES.contains(&predicate),
                "{facet}.{predicate} is a new chat busy-ness predicate"
            );
        }
    }
}

#[test]
fn keeps_owns_execution_reachable_from_both_facets() {
    for facet in FACETS {
        assert!(predicates_in(facet).contains(&"owns_execution"));
    }
}

#[test]
fn defines_the_ownership_union_in_exactly_one_place() {
    let coordinator = include_str!("../src/chat_execution_coordinator.rs")
        .split_whitespace()
        .collect::<String>();
    let unions = coordinator
        .match_indices(".has_owner(")
        .filter(|(start, prefix)| {
            coordinator[start + prefix.len()..]
                .split_once(')')
                .is_some_and(|(_, suffix)| {
                    suffix.starts_with("||self.turn_runner.is_chat_running(")
                })
        })
        .count();
    assert_eq!(unions, 1);
}
