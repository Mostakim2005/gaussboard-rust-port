// src-tauri/src/lan_sync/protocol.rs
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use x25519_dalek::{PublicKey, StaticSecret};

pub const PROTOCOL_VERSION: u32 = 1;
pub const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Fixed 12-byte ASN.1 DER SubjectPublicKeyInfo prefix for OID 1.3.101.110 (X25519)
const X25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
];

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WireEnvelope {
    pub v: u32,
    pub iv: String,
    pub tag: String,
    pub aad: Value,
    pub body: String,
}

pub fn generate_pairing_code() -> String {
    let mut bytes = [0u8; 8];
    OsRng.fill_bytes(&mut bytes);
    let mut out = String::with_capacity(9);
    for (i, b) in bytes.iter().enumerate() {
        if i == 4 {
            out.push('-');
        }
        let idx = (*b as usize) & 0x1F; // 32-char alphabet
        out.push(CODE_ALPHABET[idx] as char);
    }
    out
}

pub fn normalise_code(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_uppercase()
}

pub fn generate_x25519_keypair() -> (StaticSecret, String) {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);
    let mut spki = Vec::with_capacity(44);
    spki.extend_from_slice(&X25519_SPKI_PREFIX);
    spki.extend_from_slice(public.as_bytes());
    (secret, BASE64.encode(spki))
}

pub fn decode_x25519_pub_b64(b64: &str) -> Result<PublicKey, String> {
    let bytes = BASE64
        .decode(b64.trim())
        .map_err(|e| format!("Invalid publicKey base64: {}", e))?;

    let raw_32: [u8; 32] = if bytes.len() == 44 && bytes[..12] == X25519_SPKI_PREFIX {
        bytes[12..44].try_into().unwrap()
    } else if bytes.len() == 32 {
        bytes.as_slice().try_into().unwrap()
    } else {
        return Err(format!("Unexpected X25519 public key length: {}", bytes.len()));
    };

    Ok(PublicKey::from(raw_32))
}

pub fn diffie_hellman_shared(my_secret: &StaticSecret, their_pub_b64: &str) -> Result<[u8; 32], String> {
    let their_pub = decode_x25519_pub_b64(their_pub_b64)?;
    let shared = my_secret.diffie_hellman(&their_pub);
    let bytes = *shared.as_bytes();
    if bytes.iter().all(|&b| b == 0) {
        return Err("Rejected low-order X25519 public key".into());
    }
    Ok(bytes)
}

pub fn canonical_transcript(
    dev_a: &str,
    pub_a_b64: &str,
    dev_b: &str,
    pub_b_b64: &str,
) -> String {
    let end_a = format!("{}|{}", dev_a, pub_a_b64);
    let end_b = format!("{}|{}", dev_b, pub_b_b64);
    let (first, second) = if end_a <= end_b {
        (end_a, end_b)
    } else {
        (end_b, end_a)
    };
    format!("gazboard-pair/v{}\n{}\n{}", PROTOCOL_VERSION, first, second)
}

pub fn derive_device_key(
    shared_secret_32: &[u8; 32],
    dev_a: &str,
    pub_a_b64: &str,
    dev_b: &str,
    pub_b_b64: &str,
) -> [u8; 32] {
    let transcript = canonical_transcript(dev_a, pub_a_b64, dev_b, pub_b_b64);
    let hk = Hkdf::<Sha256>::new(Some(transcript.as_bytes()), shared_secret_32);
    let mut okm = [0u8; 32];
    hk.expand(b"gazboard-device-key", &mut okm)
        .expect("32-byte HKDF output is valid");
    okm
}

pub fn key_fingerprint(device_key: &[u8; 32]) -> String {
    let digest = Sha256::digest(device_key);
    let mut out = String::with_capacity(14);
    for i in 0..12 {
        if i == 4 || i == 8 {
            out.push('-');
        }
        let idx = (digest[i] as usize) & 0x1F;
        out.push(CODE_ALPHABET[idx] as char);
    }
    out
}

pub fn generate_confirmation(
    pairing_code: &str,
    transcript: &str,
    label: &str,
) -> Result<String, String> {
    let clean_code = normalise_code(pairing_code);
    if clean_code.is_empty() {
        return Err("Empty pairing code".into());
    }
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(clean_code.as_bytes())
        .map_err(|e| e.to_string())?;
    mac.update(format!("{}\n{}", label, transcript).as_bytes());
    Ok(BASE64.encode(mac.finalize().into_bytes()))
}

pub fn verify_confirmation_constant_time(
    pairing_code: &str,
    transcript: &str,
    primary_label: &str,
    fallback_label: &str,
    received_b64: &str,
) -> bool {
    let Ok(received_bytes) = BASE64.decode(received_b64.trim()) else {
        return false;
    };
    for label in [primary_label, fallback_label] {
        if let Ok(expected_b64) = generate_confirmation(pairing_code, transcript, label) {
            if let Ok(expected_bytes) = BASE64.decode(expected_b64) {
                if received_bytes.len() == expected_bytes.len()
                    && bool::from(received_bytes.ct_eq(&expected_bytes))
                {
                    return true;
                }
            }
        }
    }
    false
}

pub fn seal_envelope(
    device_key: &[u8; 32],
    aad_json: Value,
    plaintext: &[u8],
) -> Result<WireEnvelope, String> {
    let mut iv = [0u8; 12];
    OsRng.fill_bytes(&mut iv);

    let cipher = Aes256Gcm::new_from_slice(device_key).map_err(|e| e.to_string())?;
    let aad_bytes = serde_json::to_vec(&aad_json).map_err(|e| e.to_string())?;

    let ciphertext_with_tag = cipher
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: plaintext,
                aad: &aad_bytes,
            },
        )
        .map_err(|e| format!("AES-GCM encrypt failed: {}", e))?;

    let tag_offset = ciphertext_with_tag.len() - 16;
    let body_bytes = &ciphertext_with_tag[..tag_offset];
    let tag_bytes = &ciphertext_with_tag[tag_offset..];

    Ok(WireEnvelope {
        v: PROTOCOL_VERSION,
        iv: BASE64.encode(iv),
        tag: BASE64.encode(tag_bytes),
        aad: aad_json,
        body: BASE64.encode(body_bytes),
    })
}

pub fn open_envelope(device_key: &[u8; 32], env: &WireEnvelope) -> Result<Vec<u8>, String> {
    if env.v != PROTOCOL_VERSION {
        return Err(format!("Unsupported envelope version: {}", env.v));
    }
    let iv = BASE64
        .decode(env.iv.trim())
        .map_err(|_| "Invalid IV base64".to_string())?;
    if iv.len() != 12 {
        return Err("Invalid IV length".into());
    }
    let tag = BASE64
        .decode(env.tag.trim())
        .map_err(|_| "Invalid auth tag base64".to_string())?;
    if tag.len() != 16 {
        return Err("Invalid auth tag length".into());
    }
    let mut ciphertext = BASE64
        .decode(env.body.trim())
        .map_err(|_| "Invalid ciphertext body base64".to_string())?;

    ciphertext.extend_from_slice(&tag);
    let aad_bytes = serde_json::to_vec(&env.aad).map_err(|e| e.to_string())?;

    let cipher = Aes256Gcm::new_from_slice(device_key).map_err(|e| e.to_string())?;
    cipher
        .decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &ciphertext,
                aad: &aad_bytes,
            },
        )
        .map_err(|_| "AES-GCM authentication failed".into())
}
