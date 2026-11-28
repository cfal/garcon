use std::{cell::Cell, rc::Rc, time::Duration};

use futures::FutureExt;
use garcon_agents_common::cli_update::latest_version::{
    LatestVersionCache, LatestVersionLookup, channel_latest_version,
};
use garcon_js::clock::ManualClock;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
    task::LocalSet,
};

fn version(value: Option<&str>) -> LatestVersionLookup {
    let value = value.map(str::to_owned);
    Box::new(move || async { Ok(value) }.boxed_local())
}

#[tokio::test]
async fn keeps_found_versions_for_an_hour_and_misses_for_a_minute() {
    LocalSet::new()
        .run_until(async {
            let clock = Rc::new(ManualClock::new(0));
            let cache = LatestVersionCache::new(clock.clone());
            assert_eq!(
                cache
                    .get("found".into(), version(Some("1.0.0")), false)
                    .await
                    .as_deref(),
                Some("1.0.0")
            );
            assert_eq!(
                cache
                    .get("missing".into(), version(Some("latest")), false)
                    .await,
                None
            );
            clock.advance(59_999);
            assert_eq!(
                cache
                    .get("missing".into(), version(Some("1.0.0")), false)
                    .await,
                None
            );
            clock.advance(1);
            assert_eq!(
                cache
                    .get("missing".into(), version(Some("1.0.0")), false)
                    .await
                    .as_deref(),
                Some("1.0.0")
            );
            clock.set(3_599_999);
            assert_eq!(
                cache
                    .get("found".into(), version(Some("2.0.0")), false)
                    .await
                    .as_deref(),
                Some("1.0.0")
            );
            clock.advance(1);
            assert_eq!(
                cache
                    .get("found".into(), version(Some("2.0.0")), false)
                    .await
                    .as_deref(),
                Some("2.0.0")
            );
            assert_eq!(
                cache
                    .get("found".into(), version(Some("3.0.0")), true)
                    .await
                    .as_deref(),
                Some("3.0.0")
            );
            assert_eq!(
                cache
                    .get("stable".into(), version(Some("2.9.0")), false)
                    .await
                    .as_deref(),
                Some("2.9.0")
            );
        })
        .await;
}

#[tokio::test]
async fn shares_a_lookup_after_one_caller_leaves_and_forgets_failures() {
    LocalSet::new()
        .run_until(async {
            let cache = LatestVersionCache::default();
            let (release, gate) = oneshot::channel::<bool>();
            let calls = Rc::new(Cell::new(0));
            let first = cache.get(
                "key".into(),
                Box::new({
                    let calls = calls.clone();
                    move || {
                        async move {
                            calls.set(calls.get() + 1);
                            if gate.await.unwrap() {
                                Ok(Some("1.0.0".into()))
                            } else {
                                Err(std::io::Error::other("synthetic lookup failure").into())
                            }
                        }
                        .boxed_local()
                    }
                }),
                false,
            );
            drop(first);
            let other = cache.get("key".into(), version(Some("2.0.0")), false);
            let third = cache.get("key".into(), version(Some("3.0.0")), false);
            tokio::task::yield_now().await;
            assert_eq!(calls.get(), 1);
            release.send(false).unwrap();
            assert_eq!(tokio::join!(other, third), (None, None));
            assert_eq!(
                cache
                    .get("key".into(), version(Some("4.0.0")), false)
                    .await
                    .as_deref(),
                Some("4.0.0")
            );
        })
        .await;
}

#[tokio::test]
async fn reads_a_local_release_channel_and_times_out_during_the_body() {
    let listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (body_timeout_reached, release) = oneshot::channel();
    let server = async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = vec![0; 4096];
        let read = stream.read(&mut request).await.unwrap();
        assert!(request[..read].starts_with(b"GET /channel HTTP/1.1\r\n"));
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n1.2.3")
            .await
            .unwrap();
        drop(stream);
        let (mut stream, _) = listener.accept().await.unwrap();
        assert_ne!(stream.read(&mut request).await.unwrap(), 0);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n1.2")
            .await
            .unwrap();
        release.await.unwrap();
    };
    let client = async move {
        let url = format!("http://127.0.0.1:{port}/channel");
        let parse = |body: &str| Some(body.into());
        assert_eq!(
            channel_latest_version(url.clone(), parse)()
                .await
                .unwrap()
                .as_deref(),
            Some("1.2.3")
        );
        let version =
            tokio::time::timeout(Duration::from_secs(6), channel_latest_version(url, parse)())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(version, None);
        body_timeout_reached.send(()).unwrap();
    };
    tokio::join!(server, client);
}

#[tokio::test]
async fn release_lookup_follows_a_cross_origin_redirect_with_garcon_http_policy() {
    let first = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let second = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let url = format!(
        "http://127.0.0.1:{}/channel",
        first.local_addr().unwrap().port()
    );
    let location = format!(
        "http://127.0.0.1:{}/release",
        second.local_addr().unwrap().port()
    );
    let redirect = async move {
        let (mut stream, _) = first.accept().await.unwrap();
        let request = read_headers(&mut stream).await;
        assert!(request.starts_with("GET /channel HTTP/1.1\r\n"));
        let response = format!(
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    };
    let release = async move {
        let (mut stream, _) = second.accept().await.unwrap();
        let request = read_headers(&mut stream).await.to_ascii_lowercase();
        assert!(request.starts_with("get /release http/1.1\r\n"));
        assert!(request.contains("\r\nuser-agent: garcon/"));
        assert!(request.contains("\r\naccept-encoding: gzip, deflate, br, zstd\r\n"));
        assert!(!request.contains("\r\nauthorization:"));
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n1.2.3")
            .await
            .unwrap();
    };
    let client = async {
        let version = channel_latest_version(url, |body| Some(body.to_owned()))()
            .await
            .unwrap();
        assert_eq!(version.as_deref(), Some("1.2.3"));
    };
    tokio::time::timeout(Duration::from_secs(6), async {
        tokio::join!(redirect, release, client);
    })
    .await
    .unwrap();
}

async fn read_headers(stream: &mut tokio::net::TcpStream) -> String {
    let mut data = Vec::new();
    let mut chunk = [0; 1024];
    while !data.ends_with(b"\r\n\r\n") {
        let count = stream.read(&mut chunk).await.unwrap();
        assert_ne!(count, 0);
        data.extend_from_slice(&chunk[..count]);
    }
    String::from_utf8(data).unwrap()
}
