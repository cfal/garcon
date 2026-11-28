use std::{collections::HashSet, rc::Rc};

use garcon_contract::preambles::{PendingPreambleBoundary, Preamble};

use crate::{
    contracts::{AppendInputRequest, InputComposition, LedgerUserInputDetail, TranscriptViewId},
    sqlite_operations::LedgerResult,
};

use super::{TranscriptCommitEvent, TranscriptLedgerService};

pub struct AppendInput<'a> {
    pub view_id: &'a TranscriptViewId,
    pub detail: &'a LedgerUserInputDetail,
    pub excluded_ordinals: Option<&'a HashSet<u64>>,
    pub preamble_boundary: Option<&'a PendingPreambleBoundary>,
    pub preambles: &'a [Preamble],
}

impl TranscriptLedgerService {
    pub fn has_matching_input_submission(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        detail: &LedgerUserInputDetail,
    ) -> LedgerResult<bool> {
        self.store
            .has_matching_input_submission(chat_id, view_id, detail)
    }

    pub fn append_input_and_compose(
        &self,
        chat_id: &str,
        input: AppendInput<'_>,
    ) -> LedgerResult<Rc<InputComposition>> {
        let composition = Rc::new(self.store.append_input_and_compose(
            chat_id,
            AppendInputRequest {
                view_id: input.view_id,
                at: &input.detail.message.timestamp,
                detail: input.detail,
                excluded_ordinals: input.excluded_ordinals,
                preamble_boundary: input.preamble_boundary,
                preambles: input.preambles,
            },
        )?);
        if composition.inserted {
            self.notifications.notify(TranscriptCommitEvent::Rows {
                chat_id: chat_id.into(),
                view_id: input.view_id.clone(),
                rows: composition.committed_rows.clone(),
            });
            if let Some(id) = input
                .detail
                .client_message_id
                .as_deref()
                .filter(|id| !id.is_empty())
            {
                self.prepared_inputs
                    .borrow_mut()
                    .insert((chat_id.into(), id.into()), Rc::clone(&composition));
            }
        }
        Ok(composition)
    }

    pub fn take_prepared_input(
        &self,
        chat_id: &str,
        client_message_id: Option<&str>,
    ) -> Option<Rc<InputComposition>> {
        let id = client_message_id.filter(|id| !id.is_empty())?;
        self.prepared_inputs
            .borrow_mut()
            .remove(&(chat_id.into(), id.into()))
    }

    pub fn discard_prepared_input(&self, chat_id: &str, client_message_id: Option<&str>) {
        drop(self.take_prepared_input(chat_id, client_message_id));
    }

    pub fn has_preamble_boundary_proof(
        &self,
        chat_id: &str,
        boundary: &PendingPreambleBoundary,
    ) -> LedgerResult<bool> {
        self.store.has_preamble_boundary_proof(chat_id, boundary)
    }
}
