use std::future::Future;
use std::time::Duration;

use bluer::rfcomm::{Profile, ProfileHandle, Role, Stream};
use bluer::{Address, Device, Session, Uuid};
use futures::StreamExt;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::{log, open_adapter, require_powered};

const IAP2: Uuid = Uuid::from_u128(0x00000000_deca_fade_deca_deafdecacafe);
const ACCESSORY_IAP2: Uuid = Uuid::from_u128(0x00000000_deca_fade_deca_deafdecacaff);
const CARPLAY_ACCESSORY: Uuid = Uuid::from_u128(0xec884348_cd41_40a2_9727_575d50bf1fd3);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

fn accessory_record(service: Uuid, channel: u16, name: &str) -> String {
    format!(r#"<?xml version="1.0" encoding="UTF-8" ?>
<record>
  <attribute id="0x0001"><sequence><uuid value="{service}" /></sequence></attribute>
  <attribute id="0x0002"><uint32 value="0x00000000" /></attribute>
  <attribute id="0x0004"><sequence>
    <sequence><uuid value="0x0100" /></sequence>
    <sequence><uuid value="0x0003" /><uint8 value="{channel}" /></sequence>
  </sequence></attribute>
  <attribute id="0x0005"><sequence><uuid value="0x1002" /></sequence></attribute>
  <attribute id="0x0006"><sequence>
    <uint16 value="0x656e" /><uint16 value="0x006a" /><uint16 value="0x0100" />
    <uint16 value="0x6672" /><uint16 value="0x006a" /><uint16 value="0x0110" />
    <uint16 value="0x6465" /><uint16 value="0x006a" /><uint16 value="0x0120" />
    <uint16 value="0x6a61" /><uint16 value="0x006a" /><uint16 value="0x0130" />
  </sequence></attribute>
  <attribute id="0x0008"><uint8 value="0xff" /></attribute>
  <attribute id="0x0009"><sequence><sequence><uuid value="0x1101" /><uint16 value="0x0100" /></sequence></sequence></attribute>
  <attribute id="0x0100"><text value="{name}" /></attribute>
</record>"#)
}

fn outbound_held() -> bool {
    std::env::var_os("PLAYPORT_OUTBOUND_HOLD_FILE")
        .map(|path| std::path::Path::new(&path).exists())
        .unwrap_or(false)
}

#[derive(Debug, PartialEq)]
pub enum DrainEnd<T> {
    Opened(T),
    StdinClosed,
}

#[derive(Debug, PartialEq)]
pub enum PumpEnd {
    StdinClosed,
    RfcommClosed,
}

// The server's writes block its only link worker with no timeout, so stdin must keep draining until the channel
// opens. The bytes can be dropped: they are only link markers, which the server resends each second.
pub async fn drain_until<I: AsyncRead + Unpin, T>(
    stdin: &mut I,
    open: impl Future<Output = T>,
) -> DrainEnd<T> {
    let mut open = std::pin::pin!(open);
    let mut buf = [0u8; 4096];
    loop {
        tokio::select! {
            opened = &mut open => return DrainEnd::Opened(opened),
            read = stdin.read(&mut buf) => match read {
                Ok(0) | Err(_) => return DrainEnd::StdinClosed,
                Ok(_) => {}
            },
        }
    }
}

pub async fn pump<I, O, R>(mut stdin: I, mut stdout: O, rfcomm: R) -> Result<PumpEnd, String>
where
    I: AsyncRead + Unpin,
    O: AsyncWrite + Unpin,
    R: AsyncRead + AsyncWrite + Unpin,
{
    let (mut rfcomm_read, mut rfcomm_write) = tokio::io::split(rfcomm);

    let to_rfcomm = async {
        let mut buf = [0u8; 4096];
        loop {
            let n = stdin.read(&mut buf).await.map_err(|e| format!("stdin read failed: {e}"))?;
            if n == 0 {
                return Ok(PumpEnd::StdinClosed);
            }
            rfcomm_write
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("RFCOMM write failed: {e}"))?;
            rfcomm_write.flush().await.map_err(|e| format!("RFCOMM write failed: {e}"))?;
        }
    };
    let to_stdout = async {
        let mut buf = [0u8; 4096];
        loop {
            let n = rfcomm_read.read(&mut buf).await.map_err(|e| format!("RFCOMM read failed: {e}"))?;
            if n == 0 {
                return Ok(PumpEnd::RfcommClosed);
            }
            stdout.write_all(&buf[..n]).await.map_err(|e| format!("stdout write failed: {e}"))?;
            stdout.flush().await.map_err(|e| format!("stdout write failed: {e}"))?;
        }
    };

    tokio::select! {
        end = to_rfcomm => end,
        end = to_stdout => end,
    }
}

async fn accept_phone(handle: &mut ProfileHandle, address: Address) -> Result<Stream, String> {
    while let Some(request) = handle.next().await {
        if request.device() != address {
            log("rejecting iAP2 connection from an unconfigured phone");
            drop(request);
            continue;
        }
        return request.accept().map_err(|e| e.to_string());
    }
    Err("iAP2 profile closed".into())
}

async fn connect(
    session: &Session,
    device: &Device,
    address: Address,
) -> Result<(Vec<ProfileHandle>, Stream), String> {
    let mut incoming = session.register_profile(Profile {
        uuid: ACCESSORY_IAP2,
        name: Some("Wireless iAP".into()),
        version: Some(0x0100),
        role: Some(Role::Server),
        channel: Some(3),
        service_record: Some(accessory_record(ACCESSORY_IAP2, 3, "Wireless iAP")),
        require_authentication: Some(true),
        require_authorization: Some(false),
        ..Default::default()
    }).await.map_err(|e| format!("cannot register accessory iAP2 profile: {e}"))?;
    let mut carplay = session.register_profile(Profile {
        uuid: CARPLAY_ACCESSORY,
        name: Some("CarPlay".into()),
        version: Some(0x0100),
        role: Some(Role::Server),
        channel: Some(4),
        service_record: Some(accessory_record(CARPLAY_ACCESSORY, 4, "CarPlay")),
        require_authentication: Some(true),
        require_authorization: Some(false),
        ..Default::default()
    }).await.map_err(|e| format!("cannot register CarPlay accessory profile: {e}"))?;
    log("accessory iAP2 listener registered; waiting for configured phone");
    let profile = Profile {
        uuid: IAP2,
        role: Some(Role::Client),
        require_authentication: Some(true),
        auto_connect: Some(false),
        ..Default::default()
    };
    let mut handle = session
        .register_profile(profile)
        .await
        .map_err(|e| format!("cannot register the iAP2 profile: {e}"))?;

    // BlueZ needs the request accepted while connect_profile is still running.
    let opened = async {
        let outbound = async {
            loop {
                if outbound_held() || !device.is_paired().await.unwrap_or(false) {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
                let attempt = tokio::time::timeout(CONNECT_TIMEOUT, async {
                    let (_, stream) = tokio::try_join!(
                        async { device.connect_profile(&IAP2).await.map_err(|e| e.to_string()) },
                        accept_phone(&mut handle, address),
                    )?;
                    Ok::<_, String>(stream)
                }).await;
                match attempt {
                    Ok(Ok(stream)) => return Ok(stream),
                    Ok(Err(error)) if error == "iAP2 profile closed" => return Err(error),
                    Ok(Err(error)) => log(&format!("outbound iAP2 unavailable: {error}; listeners remain available")),
                    Err(_) => log("outbound iAP2 timed out; listeners remain available"),
                }
                for _ in 0..20 {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    if outbound_held() { break; }
                }
            }
        };
        tokio::pin!(outbound);
        tokio::select! {
            opened = &mut outbound => opened,
            opened = accept_phone(&mut incoming, address) => {
                if opened.is_ok() { log("configured phone initiated accessory iAP2 connection"); }
                opened
            }
            opened = accept_phone(&mut carplay, address) => {
                if opened.is_ok() { log("configured phone initiated CarPlay accessory connection"); }
                opened
            }
        }
    }
    .await
    .map_err(|e| format!("RFCOMM open failed: {e}"))?;
    Ok((vec![handle, incoming, carplay], opened))
}

pub async fn run(address: Address) -> Result<(), String> {
    let (session, adapter) = open_adapter().await?;
    require_powered(&adapter).await?;
    let device = adapter
        .device(address)
        .map_err(|e| format!("cannot look up device {address}: {e}"))?;
    log(&format!("RFCOMM channel opening to {address}"));
    // One handle for the whole run: an in-flight blocking read keeps its bytes in the handle, so a second would lose a chunk.
    let mut stdin = tokio::io::stdin();
    // Dropping the profile handle unregisters the profile, which closes the connection.
    let (_handle, stream) = match drain_until(&mut stdin, connect(&session, &device, address)).await {
        DrainEnd::StdinClosed => {
            log("stdin closed");
            return Ok(());
        }
        DrainEnd::Opened(opened) => opened?,
    };
    log("RFCOMM channel open");
    if let Some(path) = std::env::var_os("PLAYPORT_OUTBOUND_HOLD_FILE") {
        let _ = std::fs::remove_file(path);
    }

    match pump(stdin, tokio::io::stdout(), stream).await? {
        PumpEnd::RfcommClosed => log("RFCOMM channel closed"),
        PumpEnd::StdinClosed => log("stdin closed"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{duplex, AsyncReadExt, AsyncWriteExt, BufWriter};
    use tokio::time::{sleep, timeout};

    const MARKER: [u8; 6] = [0xff, 0x55, 0x02, 0x00, 0xee, 0x10];
    const LIMIT: Duration = Duration::from_secs(1);

    #[test]
    fn accessory_sdp_record_has_matching_channel_and_language_base() {
        for (uuid, channel, name) in [
            (ACCESSORY_IAP2, 3, "Wireless iAP"),
            (CARPLAY_ACCESSORY, 4, "CarPlay"),
        ] {
            let xml = accessory_record(uuid, channel, name);
            assert!(xml.contains(&format!("<uuid value=\"{uuid}\" />")));
            assert!(xml.contains(&format!("<uint8 value=\"{channel}\" />")));
            assert!(xml.contains("<attribute id=\"0x0006\">"));
            assert!(xml.contains("<uint16 value=\"0x656e\" />"));
        }
    }

    #[tokio::test]
    async fn bytes_before_open_are_discarded() {
        let (mut writer, mut stdin) = duplex(64);
        writer.write_all(&MARKER).await.unwrap();
        let open = async {
            sleep(Duration::from_millis(50)).await;
            7
        };
        let end = timeout(LIMIT, drain_until(&mut stdin, open)).await.unwrap();
        assert_eq!(end, DrainEnd::Opened(7));

        writer.write_all(b"after").await.unwrap();
        let mut buf = [0u8; 16];
        let n = timeout(LIMIT, stdin.read(&mut buf)).await.unwrap().unwrap();
        assert_eq!(&buf[..n], b"after");
    }

    #[tokio::test]
    async fn stdin_eof_before_open_stops_waiting() {
        let (writer, mut stdin) = duplex(64);
        drop(writer);
        let end = timeout(LIMIT, drain_until(&mut stdin, std::future::pending::<()>()))
            .await
            .unwrap();
        assert_eq!(end, DrainEnd::StdinClosed);
    }

    #[tokio::test]
    async fn pump_moves_bytes_both_ways_and_flushes_stdout() {
        let (mut stdin_writer, stdin) = duplex(64);
        let (stdout_inner, mut stdout_reader) = duplex(64);
        let stdout = BufWriter::new(stdout_inner);
        let (rfcomm, mut peer) = duplex(64);
        let task = tokio::spawn(pump(stdin, stdout, rfcomm));

        stdin_writer.write_all(&MARKER).await.unwrap();
        let mut buf = [0u8; 6];
        timeout(LIMIT, peer.read_exact(&mut buf)).await.unwrap().unwrap();
        assert_eq!(buf, MARKER);

        peer.write_all(b"reply").await.unwrap();
        let mut out = [0u8; 5];
        timeout(LIMIT, stdout_reader.read_exact(&mut out)).await.unwrap().unwrap();
        assert_eq!(&out, b"reply");
        assert!(!task.is_finished());
        task.abort();
    }

    #[tokio::test]
    async fn pump_ends_when_rfcomm_closes_while_stdin_is_idle() {
        let (_stdin_writer, stdin) = duplex(64);
        let (stdout, _stdout_reader) = duplex(64);
        let (rfcomm, peer) = duplex(64);
        drop(peer);
        let end = timeout(LIMIT, pump(stdin, stdout, rfcomm)).await.unwrap();
        assert_eq!(end, Ok(PumpEnd::RfcommClosed));
    }

    #[tokio::test]
    async fn pump_ends_when_stdin_closes() {
        let (stdin_writer, stdin) = duplex(64);
        let (stdout, _stdout_reader) = duplex(64);
        let (rfcomm, _peer) = duplex(64);
        drop(stdin_writer);
        let end = timeout(LIMIT, pump(stdin, stdout, rfcomm)).await.unwrap();
        assert_eq!(end, Ok(PumpEnd::StdinClosed));
    }

    #[tokio::test]
    async fn pump_fails_when_stdout_is_gone() {
        let (_stdin_writer, stdin) = duplex(64);
        let (stdout, stdout_reader) = duplex(64);
        drop(stdout_reader);
        let (rfcomm, mut peer) = duplex(64);
        peer.write_all(b"x").await.unwrap();
        let end = timeout(LIMIT, pump(stdin, stdout, rfcomm)).await.unwrap();
        assert!(end.is_err());
    }
}
