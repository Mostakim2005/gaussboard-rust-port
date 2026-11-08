// src-tauri/src/lan_sync/discovery.rs
use crate::lan_sync::LanSyncManager;
use if_addrs::{get_if_addrs, IfAddr};
use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    collections::HashSet,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket},
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tauri::{AppHandle, Runtime};

pub const DISCOVERY_PORT: u16 = 53319;
pub const ANNOUNCE_EVERY_MS: u64 = 3000;
pub const PEER_FORGOTTEN_AFTER_MS: u64 = 12000;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DiscoveryPacket {
    pub t: String,
    pub v: u32,
    pub id: String,
    pub name: String,
    pub port: u16,
    pub a: Vec<String>,
}

pub fn collect_local_ipv4_and_broadcasts() -> (Vec<String>, Vec<Ipv4Addr>) {
    let mut standard_ips = Vec::new();
    let mut link_local_ips = Vec::new();
    let mut bcasts = HashSet::new();
    bcasts.insert(Ipv4Addr::BROADCAST);

    if let Ok(interfaces) = get_if_addrs() {
        for iface in interfaces {
            if iface.is_loopback() {
                continue;
            }
            if let IfAddr::V4(v4) = iface.addr {
                let ip = v4.ip;
                if ip.octets()[0] == 169 && ip.octets()[1] == 254 {
                    link_local_ips.push(ip.to_string());
                } else {
                    standard_ips.push(ip.to_string());
                    let ip_u32 = u32::from(ip);
                    let mask_u32 = u32::from(v4.netmask);
                    if mask_u32 != 0 {
                        let directed = Ipv4Addr::from(ip_u32 | !mask_u32);
                        bcasts.insert(directed);
                    }
                }
            }
        }
    }

    let mut ips = if !standard_ips.is_empty() {
        standard_ips
    } else {
        link_local_ips
    };
    ips.truncate(6);
    (ips, bcasts.into_iter().collect())
}

pub fn bind_discovery_socket() -> Result<UdpSocket, String> {
    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))
        .map_err(|e| e.to_string())?;
    let _ = sock.set_reuse_address(true);
    let _ = sock.set_broadcast(true);
    let addr = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT);
    sock.bind(&addr.into()).map_err(|e| e.to_string())?;
    sock.set_nonblocking(true).map_err(|e| e.to_string())?;
    Ok(sock.into())
}

pub fn spawn_discovery_loops<R: Runtime>(app: AppHandle<R>, manager: Arc<LanSyncManager>) {
    let Ok(std_sock) = bind_discovery_socket() else {
        return;
    };
    let Ok(udp_sock) = tokio::net::UdpSocket::from_std(std_sock) else {
        return;
    };
    let udp_recv = Arc::new(udp_sock);
    let udp_send = udp_recv.clone();

    // Receiver task
    let mgr_recv = manager.clone();
    let app_recv = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut buf = [0u8; 2048];
        while mgr_recv.running.load(Ordering::SeqCst) {
            match tokio::time::timeout(Duration::from_millis(1000), udp_recv.recv_from(&mut buf)).await {
                Ok(Ok((len, src_addr))) => {
                    if let Ok(pkt) = serde_json::from_slice::<DiscoveryPacket>(&buf[..len]) {
                        if pkt.t == "gazboard" && pkt.v == 1 && pkt.id != mgr_recv.identity.read().device_id {
                            mgr_recv.record_discovered_peer(&app_recv, pkt, src_addr.ip());
                        }
                    }
                }
                _ => {}
            }
        }
    });

    // Announcer & stale peer sweep task
    let mgr_send = manager;
    let app_send = app;
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(ANNOUNCE_EVERY_MS));
        while mgr_send.running.load(Ordering::SeqCst) {
            interval.tick().await;
            let (ips, bcasts) = collect_local_ipv4_and_broadcasts();
            let ident = mgr_send.identity.read().clone();
            let port = mgr_send.http_port.load(Ordering::SeqCst);

            let pkt = DiscoveryPacket {
                t: "gazboard".to_string(),
                v: 1,
                id: ident.device_id,
                name: ident.name,
                port,
                a: ips,
            };

            if let Ok(bytes) = serde_json::to_vec(&pkt) {
                for bcast_ip in bcasts {
                    let target = SocketAddr::V4(SocketAddrV4::new(bcast_ip, DISCOVERY_PORT));
                    let _ = udp_send.send_to(&bytes, target).await;
                }
            }

            mgr_send.prune_stale_peers(&app_send);
        }
    });
}
