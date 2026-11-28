//! Ports `server/remote/transport/history-pages.ts`.

use std::pin::Pin;
use std::rc::Rc;

use futures::{Stream, StreamExt, stream};
use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome};
use serde::Serialize;

use crate::message_session::SessionError;
use crate::session_socket::SESSION_MESSAGE_BYTES;

pub const PAGE_BYTES: usize = 1024 * 1024;

struct Pages<S, Row> {
    source: Pin<Box<stream::Fuse<S>>>,
    rows: std::vec::IntoIter<Row>,
    next: Vec<Row>,
    bytes: usize,
}

pub fn history_pages<S, Row>(source: S) -> impl Stream<Item = Result<Vec<Row>, SessionError>>
where
    S: Stream<Item = Result<Vec<Row>, SessionError>>,
    Row: Serialize,
{
    let pages = Pages {
        source: Box::pin(source.fuse()),
        rows: Vec::new().into_iter(),
        next: Vec::new(),
        bytes: 0,
    };
    stream::try_unfold(pages, |mut pages| async move {
        let mut page = std::mem::take(&mut pages.next);
        let mut bytes = pages.bytes;
        pages.bytes = 0;
        loop {
            for row in pages.rows.by_ref() {
                let size = serde_json::to_vec(&row)
                    .map_err(|error| Rc::new(error) as SessionError)?
                    .len()
                    + 1;
                if size > SESSION_MESSAGE_BYTES - 1024 {
                    return Err(Rc::new(AgentCallError::new(
                        AgentDeliveryOutcome::Rejected,
                        "History row exceeds the executor message size limit",
                    )) as SessionError);
                }
                if !page.is_empty() && bytes + size > PAGE_BYTES {
                    pages.next.push(row);
                    pages.bytes = size;
                    return Ok(Some((page, pages)));
                }
                page.push(row);
                bytes += size;
            }
            match pages.source.next().await {
                Some(rows) => pages.rows = rows?.into_iter(),
                None if page.is_empty() => return Ok(None),
                None => return Ok(Some((page, pages))),
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use futures::TryStreamExt;
    use garcon_js::json::Opaque;
    use serde_json::json;

    use super::*;

    fn row_bytes(row: &Opaque) -> usize {
        serde_json::to_vec(row).unwrap().len() + 1
    }

    #[tokio::test]
    async fn fills_each_page_across_small_source_batches() {
        let batches = (0..8).map(|batch| {
            Ok((0..256).map(|index| {
                Opaque::from_value(json!({
                    "message": {"type": "assistant", "content": format!("{}:{}", batch * 256 + index, "x".repeat(1000))}
                }))
            }).collect())
        });
        let pages: Vec<Vec<Opaque>> = history_pages(stream::iter(batches))
            .try_collect()
            .await
            .unwrap();
        let rows = pages
            .iter()
            .flatten()
            .map(|row| {
                row["message"]["content"]
                    .as_str()
                    .unwrap()
                    .split_once(':')
                    .unwrap()
                    .0
                    .parse::<u64>()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(rows, (0..8 * 256).collect::<Vec<_>>());
        for (index, page) in pages.iter().enumerate() {
            let bytes = page.iter().map(row_bytes).sum::<usize>();
            assert!(bytes <= PAGE_BYTES);
            if let Some(next) = pages.get(index + 1) {
                assert!(bytes + row_bytes(&next[0]) > PAGE_BYTES);
            }
        }
    }

    #[tokio::test]
    async fn rejects_a_row_that_cannot_fit_in_a_session_packet() {
        let source = stream::iter([Ok(vec![Opaque::from_value(json!(
            "x".repeat(SESSION_MESSAGE_BYTES)
        ))])]);
        let error = history_pages(source)
            .try_collect::<Vec<_>>()
            .await
            .unwrap_err();
        let agent = error.downcast_ref::<AgentCallError>().unwrap();
        assert_eq!(agent.outcome, AgentDeliveryOutcome::Rejected);
        assert_eq!(
            agent.message,
            "History row exceeds the executor message size limit"
        );
    }
}
