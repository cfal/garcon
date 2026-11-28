//! The two English collations used by the Bun 1.4.3 server.
//!
//! On the pinned Bun, the default locale is en-US regardless of `LANG`,
//! `LC_ALL`, or `LC_COLLATE`. Its comparisons agree with explicit `en`.
//! Neither locale tailors standard root collation.
//! Bun uses radical-stroke Han ordering; ICU4X's compiled root orders Han by
//! code point. See `rust/research/collation.md` for the provisional difference.

use std::{cmp::Ordering, sync::LazyLock};

use icu_collator::{
    CollatorBorrowed, CollatorPreferences,
    options::{CollatorOptions, Strength},
    preferences::CollationNumericOrdering,
};

pub struct Collation(CollatorBorrowed<'static>);

impl Collation {
    /// `localeCompare` with no locale, or with `en` and no options.
    pub fn english() -> &'static Self {
        static COLLATION: LazyLock<Collation> = LazyLock::new(|| {
            // INFALLIBLE: ICU4X includes root collation in its compiled data.
            let collator = CollatorBorrowed::try_new(Default::default(), Default::default())
                .expect("compiled English collation");
            Collation(collator)
        });
        &COLLATION
    }

    /// English numeric collation with base sensitivity.
    pub fn english_numeric_base() -> &'static Self {
        static COLLATION: LazyLock<Collation> = LazyLock::new(|| {
            let mut preferences = CollatorPreferences::default();
            preferences.numeric_ordering = Some(CollationNumericOrdering::True);
            let mut options = CollatorOptions::default();
            options.strength = Some(Strength::Primary);
            // INFALLIBLE: ICU4X includes root collation in its compiled data.
            let collator = CollatorBorrowed::try_new(preferences, options)
                .expect("compiled numeric English collation");
            Collation(collator)
        });
        &COLLATION
    }

    pub fn compare(&self, left: &str, right: &str) -> Ordering {
        self.0.compare(left, right)
    }
}
