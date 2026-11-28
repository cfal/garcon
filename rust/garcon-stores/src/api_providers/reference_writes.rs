//! Prevents deletion while a saved selection is being published.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use garcon_base::domain_error::DomainError;
use garcon_contract::error_codes::ErrorCode;

use super::Result;

#[derive(Default)]
pub struct ApiProviderReferenceWrites {
    writers: RefCell<HashMap<String, usize>>,
    deleting: RefCell<HashSet<String>>,
}

pub struct ReferenceWrite {
    owner: Rc<ApiProviderReferenceWrites>,
    ids: HashSet<String>,
}

impl Drop for ReferenceWrite {
    fn drop(&mut self) {
        let mut writers = self.owner.writers.borrow_mut();
        for id in &self.ids {
            if let Some(count) = writers.get_mut(id) {
                *count -= 1;
                if *count == 0 {
                    writers.remove(id);
                }
            }
        }
    }
}

pub struct ProviderDeletion {
    owner: Rc<ApiProviderReferenceWrites>,
    id: String,
}

impl Drop for ProviderDeletion {
    fn drop(&mut self) {
        self.owner.deleting.borrow_mut().remove(&self.id);
    }
}

impl ApiProviderReferenceWrites {
    pub fn retain(
        self: &Rc<Self>,
        next: &[String],
        current: &[String],
        exists: impl Fn(&str) -> Result<bool>,
    ) -> Result<ReferenceWrite> {
        let mut ids: HashSet<_> = current
            .iter()
            .filter(|id| !id.is_empty())
            .cloned()
            .collect();
        for id in next.iter().filter(|id| !id.is_empty()) {
            if !ids.contains(id) && (self.deleting.borrow().contains(id) || !exists(id)?) {
                return Err(DomainError::new(
                    ErrorCode::API_PROVIDER_UNAVAILABLE,
                    "Provider is unavailable for new saved selections.",
                    409,
                    false,
                )
                .into());
            }
        }
        ids.extend(next.iter().filter(|id| !id.is_empty()).cloned());
        let mut writers = self.writers.borrow_mut();
        for id in &ids {
            *writers.entry(id.clone()).or_default() += 1;
        }
        Ok(ReferenceWrite {
            owner: Rc::clone(self),
            ids,
        })
    }

    pub fn deleting(
        self: &Rc<Self>,
        id: &str,
        is_referenced: impl FnOnce() -> Result<bool>,
    ) -> Result<ProviderDeletion> {
        let writing = self.writers.borrow().contains_key(id);
        if writing || is_referenced()? {
            return Err(DomainError::new(
                ErrorCode::API_PROVIDER_IN_USE,
                "This provider is used by saved selections or a pending save in this workspace.",
                409,
                false,
            )
            .into());
        }
        self.deleting.borrow_mut().insert(id.to_owned());
        Ok(ProviderDeletion {
            owner: Rc::clone(self),
            id: id.into(),
        })
    }
}
