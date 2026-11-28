//! Ports `server/controller/chats/carryover/context.ts`.

use std::{error::Error, future::Future, sync::Arc};

use garcon_contract::chat_types::ChatMessage;
use tokio_util::sync::CancellationToken;

use crate::token_fitting::carryover::CompactionDestination;

use super::{
    compaction::{
        CarryOverCompaction, CarryOverCompactionInput, CarryOverCompactionOperation,
        CompactionStartedObserver,
    },
    outcome::CarryOverOutcome,
    page_codec::check_signal,
    prepared_store::{PreparedCarryoverStore, TakePreparedCarryover},
};

pub struct CreateCarriedContextInput<'a> {
    pub on_compaction_started: Option<&'a CompactionStartedObserver<'a>>,
    pub chat_id: &'a str,
    pub agent_id: &'a str,
    pub executor_id: Option<&'a str>,
    pub ownership_epoch: Option<&'a str>,
    pub model: Option<&'a str>,
    pub transcript_view_id: &'a str,
    pub destination_prompt: &'a str,
    pub client_request_id: Option<&'a str>,
    pub signal: Option<&'a CancellationToken>,
}

pub async fn create_carried_context<
    F: Future<Output = Result<Vec<ChatMessage>, Box<dyn Error>>>,
>(
    input: CreateCarriedContextInput<'_>,
    read_messages: impl FnOnce() -> F,
    prepared: &PreparedCarryoverStore,
    compaction: Option<&dyn CarryOverCompaction>,
) -> Result<CarryOverOutcome, Box<dyn Error>> {
    check_signal(input.signal)?;
    if let Some(result) = prepared.take(TakePreparedCarryover {
        chat_id: input.chat_id,
        transcript_view_id: input.transcript_view_id,
        target_agent_id: input.agent_id,
        target_executor_id: input.executor_id,
        target_ownership_epoch: input.ownership_epoch,
        client_request_id: input.client_request_id,
    }) {
        return Ok(result);
    }
    let Some(compaction) = compaction else {
        return Err(std::io::Error::other("Carryover compaction is not initialized").into());
    };
    let messages = read_messages().await?;
    if let Err(error) = check_signal(input.signal) {
        tokio::task::spawn_blocking(move || drop(messages));
        return Err(error.into());
    }
    compaction
        .plan_for(CarryOverCompactionInput {
            operation: CarryOverCompactionOperation::FreshStart,
            on_compaction_started: input.on_compaction_started,
            chat_id: input.chat_id,
            messages: Arc::new(messages),
            destination: CompactionDestination {
                agent_id: input.agent_id.into(),
                model: input.model.unwrap_or_default().into(),
                prompt: Some(input.destination_prompt.into()),
            },
            signal: input.signal,
        })
        .await
}
