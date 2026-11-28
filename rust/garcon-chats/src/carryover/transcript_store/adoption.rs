use std::{error::Error, rc::Rc};

use futures::future::LocalBoxFuture;
use garcon_base::errors::{DiagnosticError, SharedDiagnosticError};
use garcon_contract::chat_types::ChatMessage;
use garcon_ledger::{
    adoption::{CarryoverQuarantine, TranscriptFrozenHistory},
    sqlite_operations::LedgerResult,
};
use tokio_util::sync::CancellationToken;

use super::{CarryOverStoreError, CarryOverTranscriptStore};
use crate::registry_contracts::{CarryOverMigrationQuarantine, CarryOverSegmentRef};

impl TranscriptFrozenHistory<Vec<CarryOverSegmentRef>> for CarryOverTranscriptStore {
    fn revision(
        &self,
        carryover: &Vec<CarryOverSegmentRef>,
        quarantine: Option<&CarryoverQuarantine>,
    ) -> String {
        let quarantine = quarantine.map(|quarantine| CarryOverMigrationQuarantine {
            artifact_id: quarantine.artifact_id.clone(),
            error_code: quarantine.error_code.clone(),
        });
        self.revision(carryover, quarantine.as_ref())
    }

    fn load_all<'a>(
        &'a self,
        carryover: &'a Vec<CarryOverSegmentRef>,
        signal: CancellationToken,
    ) -> LocalBoxFuture<'a, LedgerResult<Vec<ChatMessage>>> {
        Box::pin(async move {
            self.load_all(carryover, Some(&signal))
                .await
                .map_err(adoption_error)
        })
    }
}

fn adoption_error(error: CarryOverStoreError) -> Box<dyn Error> {
    match error {
        CarryOverStoreError::Aborted(error) => error.into(),
        CarryOverStoreError::Unavailable(error) => {
            // Adoption reads the diagnostic code after erasure.
            let cause = Rc::new(error);
            SharedDiagnosticError::new(cause.clone(), cause.diagnostic_metadata()).into()
        }
        other => other.into(),
    }
}
