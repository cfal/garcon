//! Relays upgraded connections, browser WebSockets and executor links, between
//! a client and the original.
//!
//! The original ending its side ends the relay. Unlike `copy_bidirectional`,
//! which keeps the client-to-original direction open after the original
//! closes, a client still sending queued frames cannot hold a connection open
//! that the original has ended. A client that ends its side first still
//! receives whatever the original sends until it closes.
//!
//! Browser sockets carry the original's slow-client budget (ADR-010). The
//! original drops a browser when more than `GARCON_WS_BACKPRESSURE_LIMIT` bytes
//! wait for it, but behind the relay its replies are absorbed by the extra hop
//! and the budget never trips. The relay therefore reads the original's replies
//! eagerly, as Bun does for a direct client, and drops the browser itself, the
//! same way Bun's `terminate()` does, once more than the budget waits for it.

use std::io::Cursor;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use bytes::{Bytes, BytesMut};
use hyper::upgrade::Upgraded;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpSocket, TcpStream};
use tokio::sync::mpsc;

/// Receive buffer for upgraded connections to the original. The hop is
/// loopback, where a small window costs no throughput, and keeps the relay
/// from holding extra data for clients without a budget.
const UPSTREAM_RECEIVE_BUFFER: u32 = 32 * 1024;

const READ_CHUNK: usize = 16 * 1024;

/// How the relay treats a client that stops reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlowClient {
    /// Backpressure reaches the original, which decides what to do. Executor
    /// links manage their own queues.
    Backpressure,
    /// The client is dropped once more than this many bytes wait for it.
    Drop { budget: usize },
}

#[derive(Debug, PartialEq, Eq)]
pub enum RelayEnd {
    Closed,
    ClientDropped,
}

/// Opens a dedicated connection to the original for a protocol upgrade.
pub async fn connect_upstream(authority: &str) -> std::io::Result<TcpStream> {
    let address: std::net::SocketAddr = authority.parse().map_err(|_| {
        std::io::Error::other(format!(
            "the original's address is not a socket address: {authority}"
        ))
    })?;
    let socket = if address.is_ipv4() {
        TcpSocket::new_v4()?
    } else {
        TcpSocket::new_v6()?
    };
    socket.set_recv_buffer_size(UPSTREAM_RECEIVE_BUFFER)?;
    socket.set_nodelay(true)?;
    socket.connect(address).await
}

/// Copies the original's bytes to the client, holding at most `budget` bytes
/// that the client has not accepted.
async fn copy_within_budget<R, W>(upstream: &mut R, client: &mut W, budget: usize) -> RelayEnd
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    // Atomic because the relay future must be Send; both halves run on one task.
    let waiting = AtomicUsize::new(0);
    let (chunks, mut queue) = mpsc::unbounded_channel::<Bytes>();
    let reader = async {
        // One buffer is reused; each read is split off and queued, and the
        // allocation is reclaimed once the writer has sent earlier chunks.
        let mut buffer = BytesMut::new();
        loop {
            buffer.reserve(READ_CHUNK);
            match upstream.read_buf(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if waiting.fetch_add(read, Ordering::Relaxed) + read > budget {
                        return RelayEnd::ClientDropped;
                    }
                    // The receiver lives until this function returns.
                    let _ = chunks.send(buffer.split().freeze());
                }
            }
        }
        drop(chunks);
        RelayEnd::Closed
    };
    let writer = async {
        while let Some(chunk) = queue.recv().await {
            if client.write_all(&chunk).await.is_err() {
                return;
            }
            waiting.fetch_sub(chunk.len(), Ordering::Relaxed);
        }
        let _ = client.shutdown().await;
    };
    tokio::pin!(reader, writer);
    tokio::select! {
        end = &mut reader => {
            if end == RelayEnd::ClientDropped {
                return end;
            }
            writer.await;
        }
        () = &mut writer => {}
    }
    RelayEnd::Closed
}

/// Relays bytes in both directions until the original ends the connection,
/// the client goes away, or a slow client exceeds its budget.
///
/// The halves must be independent: a write blocked on a client that stopped
/// reading must not stop the relay from reading that client's requests.
pub async fn relay<CR, CW, UR, UW>(
    (client_read, client_write): (&mut CR, &mut CW),
    (upstream_read, upstream_write): (&mut UR, &mut UW),
    slow_client: SlowClient,
) -> RelayEnd
where
    CR: AsyncRead + Unpin,
    CW: AsyncWrite + Unpin,
    UR: AsyncRead + Unpin,
    UW: AsyncWrite + Unpin,
{
    let downstream = async {
        match slow_client {
            SlowClient::Drop { budget } => {
                copy_within_budget(upstream_read, client_write, budget).await
            }
            SlowClient::Backpressure => {
                let _ = tokio::io::copy(upstream_read, client_write).await;
                let _ = client_write.shutdown().await;
                RelayEnd::Closed
            }
        }
    };
    let upstream_bound = async {
        let _ = tokio::io::copy(client_read, upstream_write).await;
        let _ = upstream_write.shutdown().await;
        std::future::pending::<RelayEnd>().await
    };
    tokio::select! {
        end = downstream => end,
        end = upstream_bound => end,
    }
}

/// Recovers the TCP connection and any bytes hyper read past the upgrade.
fn into_tcp(upgraded: Upgraded) -> Result<(TcpStream, Bytes), Upgraded> {
    let parts = upgraded.downcast::<TokioIo<TcpStream>>()?;
    Ok((parts.io.into_inner(), parts.read_buf))
}

/// Relays an upgraded client connection to the original over independent
/// socket halves.
pub async fn relay_upgraded(client: Upgraded, upstream: Upgraded, slow_client: SlowClient) {
    // Both connections are TCP connections this proxy created, so a failed
    // downcast is a programming error. It is reported, since the client has
    // already been told the upgrade succeeded; dropping both closes them.
    let (Ok((client, client_buffered)), Ok((upstream, upstream_buffered))) =
        (into_tcp(client), into_tcp(upstream))
    else {
        eprintln!("garcon-server: an upgraded connection is not TCP; closing it");
        return;
    };
    let (client_read, mut client_write) = client.into_split();
    let (upstream_read, mut upstream_write) = upstream.into_split();
    let mut client_read = Cursor::new(client_buffered).chain(client_read);
    let mut upstream_read = Cursor::new(upstream_buffered).chain(upstream_read);
    let end = relay(
        (&mut client_read, &mut client_write),
        (&mut upstream_read, &mut upstream_write),
        slow_client,
    )
    .await;
    if end == RelayEnd::ClientDropped {
        // Resets the connection instead of flushing what the client never
        // read, as the original does when it terminates a slow client.
        let _ = socket2::SockRef::from(client_write.as_ref()).set_linger(Some(Duration::ZERO));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn spawn_relay<T>(
        client: T,
        upstream: T,
        slow_client: SlowClient,
    ) -> tokio::task::JoinHandle<RelayEnd>
    where
        T: AsyncRead + AsyncWrite + Send + 'static,
    {
        tokio::spawn(async move {
            let ((mut cr, mut cw), (mut ur, mut uw)) =
                (tokio::io::split(client), tokio::io::split(upstream));
            relay((&mut cr, &mut cw), (&mut ur, &mut uw), slow_client).await
        })
    }

    #[tokio::test]
    async fn the_original_closing_ends_the_relay_while_the_client_is_still_sending() {
        let (client, mut browser) = tokio::io::duplex(1024);
        let (upstream, mut original) = tokio::io::duplex(1024);
        let relay = spawn_relay(client, upstream, SlowClient::Backpressure);
        // The browser queues more than the relay can deliver, and the original
        // stops reading and ends its side, as it does when it drops a client.
        let sending = tokio::spawn(async move {
            let chunk = vec![0u8; 64 * 1024];
            while browser.write_all(&chunk).await.is_ok() {}
            browser
        });
        original.shutdown().await.unwrap();
        let end = tokio::time::timeout(Duration::from_secs(2), relay)
            .await
            .expect("the relay ends when the original does")
            .unwrap();
        assert_eq!(end, RelayEnd::Closed);
        let mut browser = tokio::time::timeout(Duration::from_secs(2), sending)
            .await
            .expect("the browser sees its connection end")
            .unwrap();
        let mut rest = Vec::new();
        assert_eq!(browser.read_to_end(&mut rest).await.unwrap(), 0);
        drop(original);
    }

    #[tokio::test]
    async fn a_client_that_closes_first_still_receives_the_original_reply() {
        let (client, mut browser) = tokio::io::duplex(1024);
        let (upstream, mut original) = tokio::io::duplex(1024);
        let relay = spawn_relay(client, upstream, SlowClient::Drop { budget: 1 << 20 });
        browser.write_all(b"request").await.unwrap();
        browser.shutdown().await.unwrap();
        let mut received = Vec::new();
        original.read_to_end(&mut received).await.unwrap();
        assert_eq!(received, b"request");
        original.write_all(b"reply").await.unwrap();
        original.shutdown().await.unwrap();
        let mut reply = Vec::new();
        browser.read_to_end(&mut reply).await.unwrap();
        assert_eq!(reply, b"reply");
        assert_eq!(relay.await.unwrap(), RelayEnd::Closed);
    }

    #[tokio::test]
    async fn drops_a_client_that_stops_reading_once_its_budget_is_exceeded() {
        let (client, _browser_not_reading) = tokio::io::duplex(1024);
        let (upstream, mut original) = tokio::io::duplex(64 * 1024);
        let relay = spawn_relay(client, upstream, SlowClient::Drop { budget: 256 * 1024 });
        let replies = tokio::spawn(async move {
            let chunk = vec![7u8; 32 * 1024];
            let mut sent = 0;
            while sent < 8 << 20 && original.write_all(&chunk).await.is_ok() {
                sent += chunk.len();
            }
            sent
        });
        let end = tokio::time::timeout(Duration::from_secs(2), relay)
            .await
            .expect("a slow client is dropped")
            .unwrap();
        assert_eq!(end, RelayEnd::ClientDropped);
        // The original was never blocked by the slow client before the drop.
        let sent = replies.await.unwrap();
        assert!(
            sent > 256 * 1024 && sent < 8 << 20,
            "the original sent {sent} bytes"
        );
    }

    #[tokio::test]
    async fn keeps_a_reading_client_regardless_of_volume() {
        let (client, mut browser) = tokio::io::duplex(64 * 1024);
        let (upstream, mut original) = tokio::io::duplex(64 * 1024);
        let relay = spawn_relay(client, upstream, SlowClient::Drop { budget: 256 * 1024 });
        let reading = tokio::spawn(async move {
            let mut received = Vec::new();
            browser.read_to_end(&mut received).await.unwrap();
            received.len()
        });
        let chunk = vec![1u8; 64 * 1024];
        for _ in 0..128 {
            original.write_all(&chunk).await.unwrap();
        }
        original.shutdown().await.unwrap();
        assert_eq!(reading.await.unwrap(), 128 * 64 * 1024);
        assert_eq!(relay.await.unwrap(), RelayEnd::Closed);
    }

    #[tokio::test]
    async fn upstream_connections_bound_their_receive_buffer_and_disable_nagle() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stream = connect_upstream(&listener.local_addr().unwrap().to_string())
            .await
            .unwrap();
        assert!(stream.nodelay().unwrap());
        // Linux reports twice the requested size to account for bookkeeping.
        let size = socket2::SockRef::from(&stream).recv_buffer_size().unwrap();
        assert!(
            size <= 2 * UPSTREAM_RECEIVE_BUFFER as usize,
            "receive buffer is {size} bytes"
        );
    }
}
