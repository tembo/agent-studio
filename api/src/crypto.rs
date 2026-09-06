//! AES-256-GCM crypto that mirrors the TS web/src/lib/crypto.ts
//! layout (nonce || ciphertext || tag). The web side is the primary
//! encryptor; the Rust side decrypts to invoke provider APIs without
//! round-tripping the plaintext through the web container, and
//! re-encrypts when the runtime itself mints new secrets (e.g. a
//! refreshed native-MCP OAuth token).

use aes_gcm::{
    aead::{Aead, Generate, KeyInit, Payload},
    Aes256Gcm, Key, Nonce,
};
use anyhow::{anyhow, Context};
use base64::{engine::general_purpose::STANDARD, Engine as _};

const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const KEY_LEN: usize = 32;

/// Versioned-blob marker (#49). Mirrors `VERSION_AAD` in web/src/lib/crypto.ts:
/// blobs that bind row context as AAD are written as `0x01 || nonce ||
/// ciphertext || tag`; legacy blobs keep `nonce || ciphertext || tag` with no
/// version byte. Decryption tries the versioned path when the marker + an AAD
/// are present and falls back to legacy, so old ciphertext keeps decrypting.
const VERSION_AAD: u8 = 0x01;

/// Canonical AAD strings binding a ciphertext to its row. Must stay
/// byte-identical to web/src/lib/crypto-aad.ts for the rows both sides touch.
/// Fields are joined with the unit separator (0x1f); UUIDs use the
/// lowercase-hyphenated form (`Uuid`'s `Display`, same as Postgres text).
pub mod aad {
    const SEP: char = '\u{1f}';

    pub fn workspace_secret(workspace_id: uuid::Uuid, kind: &str) -> String {
        format!("workspace_secret{SEP}{workspace_id}{SEP}{kind}")
    }

    pub fn secret_connection(
        workspace_id: uuid::Uuid,
        slug: &str,
        user_id: Option<&str>,
    ) -> String {
        let shared = format!("secret_connection{SEP}{workspace_id}{SEP}{slug}");
        match user_id {
            Some(user_id) => format!("{shared}{SEP}{user_id}"),
            None => shared,
        }
    }

    pub fn native_connection(
        workspace_id: uuid::Uuid,
        user_id: &str,
        conn_type: &str,
        name: &str,
    ) -> String {
        format!("workspace_connection{SEP}{workspace_id}{SEP}{user_id}{SEP}{conn_type}{SEP}{name}")
    }

    pub fn native_oauth_client(workspace_id: uuid::Uuid, provider: &str, instance: &str) -> String {
        format!("native_oauth_client{SEP}{workspace_id}{SEP}{provider}{SEP}{instance}")
    }

    pub fn slack_secret(slack_app_id: uuid::Uuid, column: &str) -> String {
        format!("slack_app{SEP}{slack_app_id}{SEP}{column}")
    }

    pub fn sms_secret(sms_channel_id: uuid::Uuid) -> String {
        format!("sms_channel{SEP}{sms_channel_id}{SEP}auth_token")
    }
}

pub struct MasterKey(Key<Aes256Gcm>);

impl MasterKey {
    /// Load from the `TAS_ENCRYPTION_KEY` env var (32-byte base64).
    /// Same provenance as the web container's key.
    pub fn from_env() -> anyhow::Result<Self> {
        let raw = std::env::var("TAS_ENCRYPTION_KEY").context(
            "TAS_ENCRYPTION_KEY must be set so the run task can decrypt \
             workspace secrets",
        )?;
        let bytes = STANDARD
            .decode(raw.trim())
            .context("TAS_ENCRYPTION_KEY must be base64")?;
        let key = Key::<Aes256Gcm>::try_from(bytes.as_slice()).map_err(|_| {
            anyhow!(
                "TAS_ENCRYPTION_KEY must decode to {} bytes (got {})",
                KEY_LEN,
                bytes.len()
            )
        })?;
        Ok(Self(key))
    }

    /// Encrypt `plaintext` into the same `nonce || ciphertext || tag`
    /// layout the web side produces, so a blob written here is
    /// interchangeable with one written by crypto.ts. A fresh random
    /// 12-byte nonce is generated per call (AES-GCM is catastrophic on
    /// nonce reuse — never make this deterministic).
    pub fn encrypt(&self, plaintext: &str) -> anyhow::Result<Vec<u8>> {
        self.encrypt_aad(plaintext, &[])
    }

    /// Encrypt, optionally binding `aad` as additional authenticated data.
    /// Empty `aad` produces the legacy `nonce || ciphertext || tag` layout
    /// (byte-identical to pre-#49 blobs); a non-empty `aad` produces the
    /// versioned `0x01 || nonce || ciphertext || tag` layout. The matching
    /// `decrypt_aad` must pass the same `aad`.
    pub fn encrypt_aad(&self, plaintext: &str, aad: &[u8]) -> anyhow::Result<Vec<u8>> {
        let cipher = Aes256Gcm::new(&self.0);
        let nonce = Nonce::generate();
        let ciphertext = if aad.is_empty() {
            cipher.encrypt(&nonce, plaintext.as_bytes())
        } else {
            cipher.encrypt(
                &nonce,
                Payload {
                    msg: plaintext.as_bytes(),
                    aad,
                },
            )
        }
        .map_err(|e| anyhow!("encrypt failed: {e}"))?;
        let mut out = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
        if !aad.is_empty() {
            out.push(VERSION_AAD);
        }
        out.extend_from_slice(nonce.as_slice());
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    pub fn decrypt(&self, blob: &[u8]) -> anyhow::Result<String> {
        self.decrypt_aad(blob, &[])
    }

    /// Inverse of `encrypt_aad`. A versioned (0x01-prefixed) blob is decrypted
    /// with `aad`; anything else falls back to the legacy unbound layout — so
    /// pre-#49 ciphertext keeps decrypting even once a caller passes `aad`.
    pub fn decrypt_aad(&self, blob: &[u8], aad: &[u8]) -> anyhow::Result<String> {
        let cipher = Aes256Gcm::new(&self.0);

        // Versioned + AAD-bound layout, when both the marker and an AAD exist.
        if !aad.is_empty() && blob.len() >= 1 + NONCE_LEN + TAG_LEN && blob[0] == VERSION_AAD {
            let (nonce_bytes, body_and_tag) = blob[1..].split_at(NONCE_LEN);
            let nonce = Nonce::try_from(nonce_bytes).expect("split_at yields NONCE_LEN bytes");
            if let Ok(plain) = cipher.decrypt(
                &nonce,
                Payload {
                    msg: body_and_tag,
                    aad,
                },
            ) {
                return String::from_utf8(plain).context("decrypted bytes are not valid UTF-8");
            }
            // Fall through: a legacy blob whose first byte is coincidentally
            // 0x01, or a real mismatch the legacy path will also reject.
        }

        // Legacy layout: nonce || ciphertext || tag, no AAD.
        if blob.len() < NONCE_LEN + TAG_LEN {
            return Err(anyhow!("encrypted blob shorter than nonce+tag"));
        }
        let (nonce_bytes, body_and_tag) = blob.split_at(NONCE_LEN);
        let nonce = Nonce::try_from(nonce_bytes).expect("split_at yields NONCE_LEN bytes");
        let plain = cipher
            .decrypt(&nonce, body_and_tag)
            .map_err(|e| anyhow!("decrypt failed: {e}"))?;
        String::from_utf8(plain).context("decrypted bytes are not valid UTF-8")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> MasterKey {
        MasterKey(Key::<Aes256Gcm>::from([0u8; KEY_LEN]))
    }

    #[test]
    fn legacy_round_trip() {
        let k = test_key();
        let blob = k.encrypt("hunter2").unwrap();
        assert_eq!(k.decrypt(&blob).unwrap(), "hunter2");
    }

    #[test]
    fn aad_round_trip_and_marker() {
        let k = test_key();
        let aad = aad::workspace_secret(uuid::Uuid::nil(), "anthropic_api_key");
        let blob = k.encrypt_aad("sk-secret", aad.as_bytes()).unwrap();
        assert_eq!(blob[0], VERSION_AAD);
        assert_eq!(k.decrypt_aad(&blob, aad.as_bytes()).unwrap(), "sk-secret");
    }

    #[test]
    fn aad_mismatch_rejected() {
        let k = test_key();
        let a = aad::workspace_secret(uuid::Uuid::nil(), "k");
        let b = aad::secret_connection(uuid::Uuid::nil(), "k", None);
        let blob = k.encrypt_aad("v", a.as_bytes()).unwrap();
        assert!(k.decrypt_aad(&blob, b.as_bytes()).is_err());
    }

    #[test]
    fn legacy_blob_reads_even_when_aad_passed() {
        // Pre-#49 ciphertext keeps decrypting after a reader starts passing aad.
        let k = test_key();
        let legacy = k.encrypt("old-value").unwrap();
        let aad = aad::workspace_secret(uuid::Uuid::nil(), "k");
        assert_eq!(k.decrypt_aad(&legacy, aad.as_bytes()).unwrap(), "old-value");
    }

    #[test]
    fn cross_language_aad_format() {
        // Must match web/src/lib/crypto-aad.ts byte-for-byte.
        assert_eq!(
            aad::workspace_secret(uuid::Uuid::nil(), "kind"),
            "workspace_secret\u{1f}00000000-0000-0000-0000-000000000000\u{1f}kind"
        );
        assert_eq!(
            aad::secret_connection(uuid::Uuid::nil(), "key", None),
            "secret_connection\u{1f}00000000-0000-0000-0000-000000000000\u{1f}key"
        );
        assert_eq!(
            aad::secret_connection(uuid::Uuid::nil(), "key", Some("user-1")),
            "secret_connection\u{1f}00000000-0000-0000-0000-000000000000\u{1f}key\u{1f}user-1"
        );
    }
}
