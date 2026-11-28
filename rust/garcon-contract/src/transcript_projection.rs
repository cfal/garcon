//! Ports `common/transcript-projection.ts`.

use std::borrow::Cow;
use std::collections::HashSet;
use std::ptr;

use garcon_js::Number;

const PRIORITY_LADDER: &[&[&str]] = &[
    &["user-message"],
    &["assistant-message", "command-output", "command-result"],
    &[
        "read-tool-use",
        "grep-tool-use",
        "glob-tool-use",
        "list-tool-use",
    ],
    &["edit-tool-use", "write-tool-use", "apply-patch-tool-use"],
    &["bash-tool-use", "exec-tool-use"],
];

pub const PROJECTION_LONG_TAIL_LEVEL: usize = PRIORITY_LADDER.len();

pub fn projection_priority_level(message_type: &str) -> usize {
    PRIORITY_LADDER
        .iter()
        .position(|classes| classes.contains(&message_type))
        .unwrap_or(PROJECTION_LONG_TAIL_LEVEL)
}

pub type ProjectionCost<'a> = dyn Fn(&str) -> f64 + 'a;

pub trait PrioritizedProjectionEntry {
    fn level(&self) -> usize;
    fn turn(&self) -> f64;
    fn text(&self) -> &str;
    fn refit(&self, maximum_cost: f64, cost: &ProjectionCost<'_>) -> String;
}

pub struct ProjectionInput<'a, Entry> {
    pub entries: &'a [&'a Entry],
    pub turn_count: f64,
    pub maximum_cost: f64,
    pub truncation_marker_cost: f64,
    pub cost: &'a ProjectionCost<'a>,
    pub recent_turns_verbatim: Option<f64>,
}

pub struct SelectedProjectionEntry<'a, Entry> {
    pub entry: &'a Entry,
    pub text: Cow<'a, str>,
}

pub struct ProjectionSelection<'a, Entry> {
    pub selected: Vec<SelectedProjectionEntry<'a, Entry>>,
    pub truncated: bool,
    pub admission_cost: Number,
}

pub fn select_prioritized_projection<Entry: PrioritizedProjectionEntry>(
    input: ProjectionInput<'_, Entry>,
) -> ProjectionSelection<'_, Entry> {
    let mut admission = Admission {
        admitted: HashSet::new(),
        used: input.truncation_marker_cost,
        input,
    };
    admission.admit_level(0, f64::INFINITY, true);
    let recent_turns = admission.input.recent_turns_verbatim.unwrap_or(3.0);
    let pinned_from = admission.input.turn_count - recent_turns;
    let pinned_from = if pinned_from < 0.0 { 0.0 } else { pinned_from };
    let turn_limit = admission.admit_pinned_turns(pinned_from);
    for level in 0..=PROJECTION_LONG_TAIL_LEVEL {
        if !admission.admit_level(level, turn_limit, false) {
            break;
        }
    }

    let input = &admission.input;
    let mut selected: Vec<_> = input
        .entries
        .iter()
        .copied()
        .filter(|&entry| admission.contains(entry))
        .map(|entry| SelectedProjectionEntry {
            entry,
            text: Cow::Borrowed(entry.text()),
        })
        .collect();
    if selected.is_empty()
        && let Some(&latest) = input.entries.last()
    {
        let fitted = latest.refit(input.maximum_cost - admission.used, input.cost);
        if !fitted.is_empty() {
            selected.push(SelectedProjectionEntry {
                entry: latest,
                text: Cow::Owned(fitted),
            });
        }
    }
    let truncated = selected.len() != input.entries.len();
    let admission_cost = input.truncation_marker_cost
        + selected
            .iter()
            .fold(0.0, |total, entry| total + (input.cost)(&entry.text));
    ProjectionSelection {
        selected,
        truncated,
        admission_cost: Number(admission_cost),
    }
}

struct Admission<'a, Entry> {
    input: ProjectionInput<'a, Entry>,
    admitted: HashSet<*const Entry>,
    used: f64,
}

impl<'a, Entry: PrioritizedProjectionEntry> Admission<'a, Entry> {
    fn contains(&self, entry: &Entry) -> bool {
        self.admitted.contains(&ptr::from_ref(entry))
    }

    fn candidates(&self, keep: impl Fn(&Entry) -> bool) -> Vec<&'a Entry> {
        self.input
            .entries
            .iter()
            .copied()
            .filter(|&entry| keep(entry) && !self.contains(entry))
            .collect()
    }

    fn admit_all(&mut self, candidates: &[&Entry]) -> bool {
        let cost = candidates
            .iter()
            .fold(0.0, |total, entry| total + (self.input.cost)(entry.text()));
        if self.used + cost <= self.input.maximum_cost {
            self.admitted
                .extend(candidates.iter().map(|&entry| ptr::from_ref(entry)));
            self.used += cost;
            return true;
        }
        false
    }

    fn admit_pinned_turns(&mut self, mut earliest: f64) -> f64 {
        while earliest < self.input.turn_count {
            let candidates = self.candidates(|entry| entry.turn() >= earliest);
            if self.admit_all(&candidates) {
                return earliest;
            }
            earliest += 1.0;
        }
        self.input.turn_count
    }

    fn admit_level(&mut self, level: usize, turn_limit: f64, pin_oldest: bool) -> bool {
        let candidates =
            self.candidates(|entry| entry.turn() < turn_limit && entry.level() == level);
        if self.admit_all(&candidates) {
            return true;
        }

        let cost = self.input.cost;
        let maximum_cost = self.input.maximum_cost;
        if pin_oldest {
            for &pin in [candidates.last(), candidates.first()]
                .into_iter()
                .flatten()
            {
                if self.contains(pin) || self.used + cost(pin.text()) > maximum_cost {
                    continue;
                }
                self.admitted.insert(ptr::from_ref(pin));
                self.used += cost(pin.text());
            }
        }
        for &candidate in candidates.iter().rev() {
            if self.contains(candidate) {
                continue;
            }
            let entry_cost = cost(candidate.text());
            if self.used + entry_cost > maximum_cost {
                break;
            }
            self.admitted.insert(ptr::from_ref(candidate));
            self.used += entry_cost;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_js::utf16;

    struct Entry(usize, f64, String);

    impl PrioritizedProjectionEntry for Entry {
        fn level(&self) -> usize {
            self.0
        }
        fn turn(&self) -> f64 {
            self.1
        }
        fn text(&self) -> &str {
            &self.2
        }
        fn refit(&self, maximum_cost: f64, cost: &ProjectionCost<'_>) -> String {
            let mut fitted = self.text();
            while !fitted.is_empty() && cost(fitted) > maximum_cost {
                fitted = utf16::slice(fitted, 0, Some(-1));
            }
            fitted.to_owned()
        }
    }

    fn select(
        entries: Vec<Entry>,
        turn_count: f64,
        maximum_cost: f64,
        truncation_marker_cost: f64,
        recent_turns_verbatim: f64,
    ) -> (Vec<String>, bool, f64) {
        let entries: Vec<_> = entries.iter().collect();
        let result = select_prioritized_projection(ProjectionInput {
            entries: &entries,
            turn_count,
            maximum_cost,
            truncation_marker_cost,
            cost: &|text| utf16::len(text) as f64,
            recent_turns_verbatim: Some(recent_turns_verbatim),
        });
        (
            result
                .selected
                .into_iter()
                .map(|entry| entry.text.into_owned())
                .collect(),
            result.truncated,
            result.admission_cost.0,
        )
    }

    #[test]
    fn admits_asks_before_tools_and_pins_the_newest_three_turns_whole() {
        let entries = (0..6)
            .flat_map(|turn| {
                [
                    Entry(0, f64::from(turn), format!("u{turn}")),
                    Entry(4, f64::from(turn), format!("t{turn}")),
                ]
            })
            .collect();
        let (selected, truncated, admission_cost) = select(entries, 6.0, 18.0, 0.0, 3.0);
        assert_eq!(
            selected,
            ["u0", "u1", "u2", "u3", "t3", "u4", "t4", "u5", "t5"]
        );
        assert!(truncated);
        assert_eq!(admission_cost, 18.0);
    }

    #[test]
    fn protects_the_newest_and_oldest_asks_when_asks_alone_overflow() {
        let entries = (0..8)
            .map(|turn| Entry(0, f64::from(turn), format!("request-{turn}")))
            .collect();
        assert_eq!(
            select(entries, 8.0, 18.0, 0.0, 0.0).0,
            ["request-0", "request-7"]
        );
    }

    #[test]
    fn stops_at_the_first_incomplete_priority_level_and_preserves_source_order() {
        let entries = [
            (0, 0.0, "ask"),
            (1, 0.0, "old-assistant"),
            (2, 0.0, "read"),
            (1, 1.0, "new-assistant"),
        ]
        .into_iter()
        .map(|(level, turn, text)| Entry(level, turn, text.into()))
        .collect();
        assert_eq!(
            select(entries, 2.0, 16.0, 0.0, 0.0).0,
            ["ask", "new-assistant"]
        );
    }

    #[test]
    fn refits_the_latest_entry_when_no_complete_entry_fits() {
        let entries = vec![Entry(5, 0.0, "latest-long-entry".into())];
        let (selected, truncated, cost) = select(entries, 1.0, 6.0, 1.0, 0.0);
        assert_eq!(selected, ["lates"]);
        assert!(!truncated);
        assert_eq!(cost, 6.0);
    }
}
