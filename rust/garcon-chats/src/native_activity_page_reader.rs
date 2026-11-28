//! Schedules an advisory native-history probe after a successful activation read.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_contract::{
    chat_view::{TranscriptPage, TranscriptReadPurpose},
    transcript_anchor_page::{TranscriptAnchorDirection, TranscriptAnchorRequest},
};
use garcon_interface::resources::ExecutorResult;
use garcon_ledger::view_reader::TranscriptAnchorRead;
use tokio_util::sync::CancellationToken;

use crate::chat_message_reader::{TranscriptAnchorPageReader, TranscriptPageReader};

pub trait NativeActivityCheck {
    fn request_activation_check(&self, chat_id: &str);
}

pub struct NativeActivityReaders {
    pub pages: Rc<dyn TranscriptPageReader>,
    pub anchors: Rc<dyn TranscriptAnchorPageReader>,
    pub native_activity: Rc<dyn NativeActivityCheck>,
}

impl NativeActivityReaders {
    fn schedule_check(&self, chat_id: &str) {
        let activity = Rc::clone(&self.native_activity);
        let chat_id = chat_id.to_owned();
        tokio::task::spawn_local(async move {
            activity.request_activation_check(&chat_id);
        });
    }
}

#[async_trait(?Send)]
impl TranscriptPageReader for NativeActivityReaders {
    async fn page(
        &self,
        chat_id: &str,
        limit: u64,
        before_ordinal: Option<u64>,
        expected_transcript_view_id: Option<&str>,
        signal: &CancellationToken,
        purpose: Option<TranscriptReadPurpose>,
    ) -> ExecutorResult<TranscriptPage> {
        let page = self
            .pages
            .page(
                chat_id,
                limit,
                before_ordinal,
                expected_transcript_view_id,
                signal,
                None,
            )
            .await?;
        if purpose == Some(TranscriptReadPurpose::Activation) && before_ordinal.is_none() {
            self.schedule_check(chat_id);
        }
        Ok(page)
    }
}

#[async_trait(?Send)]
impl TranscriptAnchorPageReader for NativeActivityReaders {
    async fn anchor_page(
        &self,
        request: &TranscriptAnchorRequest,
        signal: &CancellationToken,
    ) -> ExecutorResult<TranscriptAnchorRead> {
        let page = self.anchors.anchor_page(request, signal).await?;
        if request.purpose == Some(TranscriptReadPurpose::Activation)
            && request.direction == TranscriptAnchorDirection::Backward
            && request.cursor_ordinal.is_none()
            && request.watermark_ordinal.is_none()
        {
            self.schedule_check(&request.chat_id);
        }
        Ok(page)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use garcon_contract::transcript_anchor_page::TranscriptAnchorPageStatus;

    use super::*;

    struct Pages;

    #[async_trait(?Send)]
    impl TranscriptPageReader for Pages {
        async fn page(
            &self,
            chat_id: &str,
            _: u64,
            _: Option<u64>,
            _: Option<&str>,
            _: &CancellationToken,
            purpose: Option<TranscriptReadPurpose>,
        ) -> ExecutorResult<TranscriptPage> {
            assert!(purpose.is_none());
            if chat_id == "error" {
                return Err("history unavailable".into());
            }
            Ok(TranscriptPage {
                transcript_view_id: "view".into(),
                messages: vec![],
                last_ordinal: 0,
                page_oldest_ordinal: 0,
                page_newest_ordinal: 0,
                next_before_ordinal: None,
                has_more: false,
            })
        }
    }

    #[async_trait(?Send)]
    impl TranscriptAnchorPageReader for Pages {
        async fn anchor_page(
            &self,
            request: &TranscriptAnchorRequest,
            _: &CancellationToken,
        ) -> ExecutorResult<TranscriptAnchorRead> {
            if request.chat_id == "error" {
                return Err("history unavailable".into());
            }
            Ok(TranscriptAnchorRead {
                start_ordinal: 0,
                end_ordinal: 0,
                anchors_remaining: 0,
                page_status: TranscriptAnchorPageStatus::Exhausted,
                direction: request.direction,
                transcript_view_id: garcon_ledger::contracts::transcript_view_id("view").unwrap(),
                watermark_ordinal: 0,
                last_ordinal: 0,
                messages: vec![],
            })
        }
    }

    #[derive(Default)]
    struct Checks(RefCell<Vec<String>>);

    impl NativeActivityCheck for Checks {
        fn request_activation_check(&self, chat_id: &str) {
            self.0.borrow_mut().push(chat_id.into());
        }
    }

    #[tokio::test]
    async fn only_successful_newest_activation_reads_schedule_probes_after_returning() {
        use TranscriptAnchorDirection::{Backward, Forward};
        let tasks = tokio::task::LocalSet::new();
        let checks = Rc::new(Checks::default());
        tasks
            .run_until(async {
                let readers = NativeActivityReaders {
                    pages: Rc::new(Pages),
                    anchors: Rc::new(Pages),
                    native_activity: checks.clone(),
                };
                let signal = CancellationToken::new();
                let activation = Some(TranscriptReadPurpose::Activation);
                readers
                    .page("raw", 20, None, Some("view"), &signal, activation)
                    .await
                    .unwrap();
                readers
                    .page("older", 20, Some(4), Some("view"), &signal, activation)
                    .await
                    .unwrap();
                readers
                    .page("background", 20, None, None, &signal, None)
                    .await
                    .unwrap();
                assert!(
                    readers
                        .page("error", 20, None, None, &signal, activation)
                        .await
                        .is_err()
                );
                for (id, direction, cursor, watermark, purpose) in [
                    ("anchor", Backward, None, None, activation),
                    ("forward", Forward, None, None, activation),
                    ("cursor", Backward, Some(5), None, activation),
                    ("watermark", Backward, None, Some(9), activation),
                    ("background", Backward, None, None, None),
                    ("error", Backward, None, None, activation),
                ] {
                    let result = readers
                        .anchor_page(
                            &TranscriptAnchorRequest {
                                chat_id: id.into(),
                                direction,
                                anchors_remaining: 100,
                                transcript_view_id: Some("view".into()),
                                cursor_ordinal: cursor,
                                watermark_ordinal: watermark,
                                purpose,
                            },
                            &signal,
                        )
                        .await;
                    assert_eq!(result.is_err(), id == "error");
                }
                assert!(checks.0.borrow().is_empty());
            })
            .await;
        tasks.await;
        assert_eq!(*checks.0.borrow(), ["raw", "anchor"]);
    }
}
