//! Hashes of text. The TypeScript twin is `apps/plugin/src/publishing/hash.ts`.

use std::fmt::Write;

use sha2::{Digest, Sha256};

/// The SHA-256 of a text as UTF-8, in small hexadecimal digits.
pub fn sha256_hex(text: &str) -> String {
    let mut hex = String::with_capacity(64);
    for byte in Sha256::digest(text.as_bytes()) {
        // Writing to a `String` cannot fail.
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// The hash of a text in the form of the manifest: `sha256:` and the digits.
pub fn content_hash(text: &str) -> String {
    format!("sha256:{}", sha256_hex(text))
}

/// The hash of bytes, as they are, in the form of the manifest.
pub fn bytes_hash(bytes: &[u8]) -> String {
    let mut hex = String::from("sha256:");
    for byte in Sha256::digest(bytes) {
        // Writing to a `String` cannot fail.
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}
