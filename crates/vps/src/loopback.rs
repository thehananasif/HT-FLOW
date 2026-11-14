//! In-process SSH server on 127.0.0.1 (russh server side): exercises the real client end to end
//! — key exchange, host-key pinning, password and key auth, exec with stdin and exit status.

use std::sync::Arc;
use std::time::Duration;

use russh::server::{self, Auth as SAuth, Msg, Session as SSession};
use russh::{Channel, ChannelId};
use tokio::net::TcpListener;
use zeroize::Zeroizing;

use crate::keys::{fingerprint, parse_private_key};
use crate::{fetch_host_key, Auth, Error, HostKeyPolicy, Session, Target};

// RFC 8410 §10.3 test vector (host key) — not a real key.
const HOST_KEY: &str = "-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEINTuctv5E1hK1bbY8fdp+K06/nwoy/HU++CXqI9EdVhC
-----END PRIVATE KEY-----";

#[derive(Default)]
struct Echo {
    cmd: Vec<u8>,
    input: Vec<u8>,
}

impl server::Handler for Echo {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<SAuth, Self::Error> {
        Ok(if user == "trader" && password == "s3cret" {
            SAuth::Accept
        } else {
            SAuth::reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut SSession,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut SSession,
    ) -> Result<(), Self::Error> {
        self.cmd = data.to_vec();
        session.channel_success(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut SSession,
    ) -> Result<(), Self::Error> {
        self.input.extend_from_slice(data);
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut SSession,
    ) -> Result<(), Self::Error> {
        let mut out = b"cmd=".to_vec();
        out.extend_from_slice(&self.cmd);
        out.extend_from_slice(b" stdin=");
        out.extend_from_slice(&self.input);
        session.data(channel, out)?;
        session.extended_data(channel, 1, b"warn".to_vec())?;
        session.exit_status_request(channel, 7)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
}

async fn serve() -> (Target, String) {
    let key = parse_private_key(HOST_KEY, None).unwrap();
    let fp = fingerprint(key.public_key());
    let config = Arc::new(server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let cfg = config.clone();
            tokio::spawn(async move {
                if let Ok(s) = server::run_stream(cfg, sock, Echo::default()).await {
                    let _ = s.await;
                }
            });
        }
    });
    (Target::new("127.0.0.1", port, "trader").unwrap(), fp)
}

fn pw(p: &str) -> Auth {
    Auth::Password(Zeroizing::new(p.to_string()))
}

#[tokio::test]
async fn exec_roundtrip_with_pinning() {
    let (target, fp) = serve().await;

    // Trust on first use: read the key without logging in.
    assert_eq!(fetch_host_key(&target).await.unwrap(), fp);

    let s = Session::connect(&target, &pw("s3cret"), HostKeyPolicy::Pin(fp.clone()))
        .await
        .unwrap();
    assert_eq!(s.fingerprint, fp);
    let out = s
        .exec_collect("echo hi", Some(b"payload"), Duration::from_secs(5), 1024)
        .await
        .unwrap();
    assert_eq!(out.code, Some(7));
    assert_eq!(out.stdout, "cmd=echo hi stdin=payload");
    assert_eq!(out.stderr, "warn");
    assert!(!out.truncated);

    // Streaming callback and truncation.
    let mut chunks = 0;
    s.exec("x", None, Duration::from_secs(5), |_, _| chunks += 1)
        .await
        .unwrap();
    assert!(chunks >= 2);
    let out = s
        .exec_collect("long", None, Duration::from_secs(5), 4)
        .await
        .unwrap();
    assert_eq!(out.stdout, "cmd=");
    assert!(out.truncated);
    s.disconnect().await;
}

#[tokio::test]
async fn rejects_wrong_pin_and_wrong_password() {
    let (target, fp) = serve().await;
    let wrong = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string();
    match Session::connect(&target, &pw("s3cret"), HostKeyPolicy::Pin(wrong)).await {
        Err(Error::HostKeyMismatch { actual, .. }) => assert_eq!(actual, fp),
        other => panic!("expected a host key mismatch, got {:?}", other.err()),
    }
    match Session::connect(&target, &pw("nope"), HostKeyPolicy::Pin(fp)).await {
        Err(Error::AuthFailed) => {}
        other => panic!("expected an auth failure, got {:?}", other.err()),
    }
}

#[tokio::test]
async fn connect_refused_is_reported() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let t = Target::new("127.0.0.1", port, "u").unwrap();
    let e = fetch_host_key(&t).await.unwrap_err();
    assert!(matches!(e, Error::Connect(_)), "{e:?}");
    assert_eq!(e.code(), "vps.connect");
}
