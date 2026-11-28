//! Unicode 17 properties, matching the pinned Bun's Unicode regex classes.

use icu_properties::{
    CodePointMapData, CodePointSetData,
    props::{GeneralCategory, GeneralCategoryGroup, WhiteSpace},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Category(GeneralCategory);

impl Category {
    pub fn is_letter(self) -> bool {
        GeneralCategoryGroup::Letter.contains(self.0)
    }
    pub fn is_number(self) -> bool {
        GeneralCategoryGroup::Number.contains(self.0)
    }
    pub fn is_mark(self) -> bool {
        GeneralCategoryGroup::Mark.contains(self.0)
    }
    pub fn is_format(self) -> bool {
        self.0 == GeneralCategory::Format
    }
}

pub fn category(character: char) -> Category {
    Category(CodePointMapData::<GeneralCategory>::new().get(character))
}

pub fn is_white_space(character: char) -> bool {
    CodePointSetData::new::<WhiteSpace>().contains(character)
}
