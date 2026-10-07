//! Outbound SOCKS5 proxy + DNS-over-HTTPS fallback for hijacked system DNS.
//!
//! Some VPN clients (WireSock Secure Connect, Clash/mihomo-style) answer DNS
//! with fake IPs in 198.18.0.0/15 and keep doing so after the tunnel drops.
//! Split tunneling still routes our traffic directly, so only *resolution* is
//! broken: connecting to the fake IP times out. Instead of failing, yt-dlp is
//! pointed at a loopback SOCKS5 proxy (`socks5h://127.0.0.1:port`) which
//! resolves hostnames itself — system DNS first (filtered), DNS-over-HTTPS as
//! fallback — and connects directly. No admin rights, no system changes.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// DNS-over-HTTPS JSON endpoints (`application/dns-json`, Cloudflare +
/// Google shape). Literal IPs, so a poisoned resolver can't sink them — both
/// operators serve these addresses on valid certificates.
const DOH_ENDPOINTS: [&str; 4] = [
    "https://1.1.1.1/dns-query",
    "https://1.0.0.1/dns-query",
    "https://8.8.8.8/resolve",
    "https://8.8.4.4/resolve",
];
const DOH_TIMEOUT: Duration = Duration::from_secs(6);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CACHE_TTL: Duration = Duration::from_secs(300);

/// VPN/DNS-hijack fake space (Clash/WireSock/mihomo-style): 198.18.0.0/15.
pub fn is_fake_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 198 && (o[1] & 0xfe) == 18
        }
        _ => false,
    }
}

/// True for IPs no public host should ever resolve to: the fake space plus
/// unspecified / loopback / private / link-local / multicast / reserved.
pub fn is_unusable_ip(ip: &IpAddr) -> bool {
    if is_fake_ip(ip) {
        return true;
    }
    match ip {
        IpAddr::V4(v4) => {
            v4.is_unspecified()
                || v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.octets()[0] == 0
                || (v4.octets()[0] & 0xf0) == 0xf0 // 240.0.0.0/4 reserved
        }
        IpAddr::V6(v6) => {
            v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

fn doh_client() -> &'static wreq::Client {
    static CLIENT: OnceLock<wreq::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        wreq::Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .read_timeout(Duration::from_secs(15))
            .build()
            .expect("doh client")
    })
}

fn dns_cache() -> &'static Mutex<HashMap<String, (Vec<IpAddr>, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Vec<IpAddr>, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_get(host: &str) -> Option<Vec<IpAddr>> {
    let cache = dns_cache().lock().ok()?;
    let (ips, at) = cache.get(host)?;
    if at.elapsed() < CACHE_TTL {
        Some(ips.clone())
    } else {
        None
    }
}

fn cache_put(host: &str, ips: &[IpAddr]) {
    if let Ok(mut cache) = dns_cache().lock() {
        if cache.len() > 512 {
            cache.clear();
        }
        cache.insert(host.to_string(), (ips.to_vec(), Instant::now()));
    }
}

/// Usable IPs from a DNS-JSON answer body (`type` 1 = A, 28 = AAAA).
fn usable_answers(json: &serde_json::Value, want_type: u64) -> Vec<IpAddr> {
    let mut out = Vec::new();
    let Some(answers) = json.get("Answer").and_then(|a| a.as_array()) else {
        return out;
    };
    for answer in answers {
        if answer.get("type").and_then(|t| t.as_u64()) != Some(want_type) {
            continue;
        }
        let Some(data) = answer.get("data").and_then(|d| d.as_str()) else {
            continue;
        };
        if let Ok(ip) = data.trim().trim_end_matches('.').parse::<IpAddr>()
            && !is_unusable_ip(&ip)
            && !out.contains(&ip)
        {
            out.push(ip);
        }
    }
    out
}

/// One DNS-over-HTTPS JSON query against `endpoint`.
async fn doh_lookup(endpoint: &str, host: &str, qtype: &str) -> Result<Vec<IpAddr>, String> {
    let url = format!("{endpoint}?name={host}&type={qtype}");
    let resp = tokio::time::timeout(
        DOH_TIMEOUT,
        doh_client()
            .get(&url)
            .header("accept", "application/dns-json")
            .send(),
    )
    .await
    .map_err(|_| format!("DoH {endpoint} timed out"))?
    .map_err(|e| format!("DoH {endpoint}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("DoH {endpoint}: HTTP {}", resp.status()));
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| format!("DoH {endpoint} body: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_slice(&body).map_err(|e| format!("DoH {endpoint} JSON: {e}"))?;
    if json.get("Status").and_then(|s| s.as_u64()) != Some(0) {
        return Err(format!("DoH {endpoint}: non-NOERROR for {host}"));
    }
    Ok(usable_answers(&json, if qtype == "AAAA" { 28 } else { 1 }))
}

/// Resolve `host` to usable IPs: system DNS first (filtered — the fast path
/// for clean hosts), then DNS-over-HTTPS. Results are cached for `CACHE_TTL`.
pub async fn resolve_clean(host: &str) -> Result<Vec<IpAddr>, String> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return if is_unusable_ip(&ip) {
            Err(format!("{host} is not a usable address"))
        } else {
            Ok(vec![ip])
        };
    }
    if let Some(hit) = cache_get(host) {
        return Ok(hit);
    }

    // Fast path: the system resolver is fine for everything but hijacked names.
    if let Ok(addrs) = tokio::net::lookup_host((host, 443)).await {
        let mut clean: Vec<IpAddr> = Vec::new();
        for addr in addrs {
            let ip = addr.ip();
            if !is_unusable_ip(&ip) && !clean.contains(&ip) {
                clean.push(ip);
            }
        }
        if !clean.is_empty() {
            cache_put(host, &clean);
            return Ok(clean);
        }
    }

    // Fallback: resolve out-of-band so a poisoned resolver can't sink us.
    let mut doh_errors = Vec::new();
    for endpoint in DOH_ENDPOINTS {
        match doh_lookup(endpoint, host, "A").await {
            Ok(ips) if !ips.is_empty() => {
                cache_put(host, &ips);
                return Ok(ips);
            }
            Ok(_) => {}
            Err(e) => doh_errors.push(e),
        }
    }
    for endpoint in DOH_ENDPOINTS {
        match doh_lookup(endpoint, host, "AAAA").await {
            Ok(ips) if !ips.is_empty() => {
                cache_put(host, &ips);
                return Ok(ips);
            }
            Ok(_) => {}
            Err(e) => doh_errors.push(e),
        }
    }
    Err(format!("no usable address for {host} ({})", doh_errors.join("; ")))
}

static PROXY_ADDR: OnceLock<tokio::sync::Mutex<Option<SocketAddr>>> = OnceLock::new();

/// Local SOCKS5 (CONNECT only, no auth) for traffic that must bypass a
/// hijacked resolver. Binds 127.0.0.1 on an ephemeral port once per process;
/// the accept loop lives on the runtime.
pub async fn ensure_local_proxy() -> Result<SocketAddr, String> {
    let slot = PROXY_ADDR.get_or_init(|| tokio::sync::Mutex::new(None));
    let mut guard = slot.lock().await;
    if let Some(addr) = *guard {
        return Ok(addr);
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind bypass proxy: {e}"))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("proxy addr: {e}"))?;
    tokio::spawn(async move { serve(listener).await });
    *guard = Some(addr);
    println!("[socks] bypass proxy on {addr}");
    Ok(addr)
}

async fn serve(listener: TcpListener) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream).await {
                eprintln!("[socks] {e}");
            }
        });
    }
}

async fn reply(stream: &mut TcpStream, code: u8) {
    let _ = stream
        .write_all(&[0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await;
}

async fn handle_conn(mut stream: TcpStream) -> Result<(), String> {
    // Handshake: VER NMETHODS METHODS* — no-auth only.
    let mut hdr = [0u8; 2];
    stream
        .read_exact(&mut hdr)
        .await
        .map_err(|e| format!("socks handshake: {e}"))?;
    if hdr[0] != 0x05 {
        return Err("socks: not version 5".into());
    }
    let mut methods = vec![0u8; hdr[1] as usize];
    stream
        .read_exact(&mut methods)
        .await
        .map_err(|e| format!("socks methods: {e}"))?;
    if !methods.contains(&0x00) {
        stream.write_all(&[0x05, 0xff]).await.ok();
        return Err("socks: no acceptable auth method".into());
    }
    stream
        .write_all(&[0x05, 0x00])
        .await
        .map_err(|e| format!("socks select: {e}"))?;

    // Request: VER CMD RSV ATYP ADDR PORT — CONNECT only.
    let mut req = [0u8; 4];
    stream
        .read_exact(&mut req)
        .await
        .map_err(|e| format!("socks request: {e}"))?;
    if req[0] != 0x05 {
        return Err("socks: bad request version".into());
    }
    if req[1] != 0x01 {
        reply(&mut stream, 0x07).await;
        return Err("socks: only CONNECT is supported".into());
    }
    let host = match req[3] {
        0x01 => {
            let mut b = [0u8; 4];
            stream
                .read_exact(&mut b)
                .await
                .map_err(|e| format!("socks addr: {e}"))?;
            Ipv4Addr::from(b).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream
                .read_exact(&mut len)
                .await
                .map_err(|e| format!("socks domain len: {e}"))?;
            let mut b = vec![0u8; len[0] as usize];
            stream
                .read_exact(&mut b)
                .await
                .map_err(|e| format!("socks domain: {e}"))?;
            String::from_utf8(b).map_err(|_| "socks: domain is not UTF-8".to_string())?
        }
        0x04 => {
            let mut b = [0u8; 16];
            stream
                .read_exact(&mut b)
                .await
                .map_err(|e| format!("socks addr: {e}"))?;
            Ipv6Addr::from(b).to_string()
        }
        _ => {
            reply(&mut stream, 0x08).await;
            return Err("socks: unsupported address type".into());
        }
    };
    let mut port = [0u8; 2];
    stream
        .read_exact(&mut port)
        .await
        .map_err(|e| format!("socks port: {e}"))?;
    let port = u16::from_be_bytes(port);

    // Literals are the client's own resolution (standard SOCKS semantic) —
    // only domain names go through the filtered resolver.
    let mut ips: Vec<IpAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => match resolve_clean(&host).await {
            Ok(ips) => ips,
            Err(e) => {
                reply(&mut stream, 0x04).await;
                return Err(format!("socks resolve {host}: {e}"));
            }
        },
    };
    ips.sort_by_key(|ip| matches!(ip, IpAddr::V6(_)));

    let mut last_err = String::from("no addresses");
    for ip in ips {
        match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((ip, port))).await {
            Ok(Ok(mut upstream)) => {
                reply(&mut stream, 0x00).await;
                tokio::io::copy_bidirectional(&mut stream, &mut upstream)
                    .await
                    .map_err(|e| format!("socks relay {host}:{port}: {e}"))?;
                return Ok(());
            }
            Ok(Err(e)) => last_err = e.to_string(),
            Err(_) => last_err = "connect timed out".to_string(),
        }
    }
    reply(&mut stream, 0x05).await;
    Err(format!("socks connect {host}:{port}: {last_err}"))
}

#[cfg(test)]
mod tests {
    use super::{is_fake_ip, is_unusable_ip, usable_answers};
    use std::net::IpAddr;

    #[test]
    fn detects_fake_ips() {
        assert!(is_fake_ip(&"198.18.178.1".parse().unwrap()));
        assert!(is_fake_ip(&"198.19.0.1".parse().unwrap()));
        assert!(!is_fake_ip(&"198.20.0.1".parse().unwrap()));
        assert!(!is_fake_ip(&"142.250.72.14".parse().unwrap()));
        assert!(!is_fake_ip(&"::1".parse().unwrap()));
    }

    #[test]
    fn filters_unusable_ips() {
        for s in [
            "198.18.0.1",
            "0.0.0.0",
            "127.0.0.1",
            "10.0.0.1",
            "192.168.1.1",
            "172.16.0.1",
            "169.254.1.1",
            "224.0.0.1",
            "240.0.0.1",
            "192.0.2.1",
            "::",
            "::1",
            "fe80::1",
            "fc00::1",
            "ff02::1",
        ] {
            assert!(is_unusable_ip(&s.parse().unwrap()), "{s}");
        }
        for s in [
            "142.250.72.14",
            "1.1.1.1",
            "8.8.8.8",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
        ] {
            assert!(!is_unusable_ip(&s.parse().unwrap()), "{s}");
        }
    }

    #[test]
    fn parses_doh_answers() {
        let json: serde_json::Value = serde_json::from_str(
            r#"{"Status":0,"Answer":[
                {"name":"www.youtube.com.","type":1,"TTL":300,"data":"142.251.150.4"},
                {"name":"www.youtube.com.","type":1,"TTL":300,"data":"198.18.178.1"},
                {"name":"www.youtube.com.","type":28,"TTL":300,"data":"2606:4700:4700::1111"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(
            usable_answers(&json, 1),
            vec!["142.251.150.4".parse::<IpAddr>().unwrap()]
        );
        assert_eq!(
            usable_answers(&json, 28),
            vec!["2606:4700:4700::1111".parse::<IpAddr>().unwrap()]
        );
    }

    /// Local-only: full SOCKS5 handshake + CONNECT relay against a loopback
    /// echo server. No DNS, no internet.
    #[tokio::test]
    async fn socks_relay_roundtrip() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let echo = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let echo_addr = echo.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = echo.accept().await.unwrap();
            let (mut r, mut w) = s.split();
            tokio::io::copy(&mut r, &mut w).await.ok();
        });

        let proxy = super::ensure_local_proxy().await.expect("proxy");
        let mut c = tokio::net::TcpStream::connect(proxy).await.unwrap();
        c.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
        let mut rep = [0u8; 2];
        c.read_exact(&mut rep).await.unwrap();
        assert_eq!(rep, [0x05, 0x00]);

        let mut req = vec![0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1];
        req.extend_from_slice(&echo_addr.port().to_be_bytes());
        c.write_all(&req).await.unwrap();
        let mut conn_rep = [0u8; 10];
        c.read_exact(&mut conn_rep).await.unwrap();
        assert_eq!(conn_rep[1], 0x00);

        c.write_all(b"ping").await.unwrap();
        let mut back = [0u8; 4];
        c.read_exact(&mut back).await.unwrap();
        assert_eq!(&back, b"ping");
    }

    /// Live: DoH actually resolves through the hijack.
    /// Run with `cargo test --lib socks::tests::live_doh -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "live network"]
    async fn live_doh_resolves_youtube() {
        let ips = super::resolve_clean("www.youtube.com")
            .await
            .expect("doh");
        assert!(!ips.is_empty());
        assert!(ips.iter().all(|ip| !super::is_unusable_ip(ip)));
        println!("clean: {ips:?}");
    }
}
