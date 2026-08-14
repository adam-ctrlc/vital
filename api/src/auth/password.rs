use std::sync::OnceLock;

use argon2::Argon2;
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};

use crate::error::{AppError, AppResult};

pub fn hash(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hashed| hashed.to_string())
        .map_err(|_| AppError::PasswordHash)
}

pub fn verify(password: &str, password_hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(password_hash) else {
        return false;
    };

    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// Runs a verification against a fixed dummy hash so the no-account path costs the
/// same argon2 work as a real one. If the pad cannot be built, it simply skips the
/// work; timing parity is best effort and never a reason to fail the request.
pub fn verify_dummy(password: &str) {
    static PAD: OnceLock<String> = OnceLock::new();

    let pad = PAD.get_or_init(|| hash("dynavolt-timing-pad").unwrap_or_default());
    if !pad.is_empty() {
        let _ = verify(password, pad);
    }
}
