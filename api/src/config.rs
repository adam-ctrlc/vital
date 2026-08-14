use crate::error::{AppError, AppResult};

/// How often a reading is written to storage.
///
/// Not how often the dashboard updates: that polls every second and stays live.
/// A transformer's thermal behaviour moves over minutes, so storing every 1.5s
/// bought no insight and filled the database roughly ten times faster.
const DEFAULT_SAMPLE_INTERVAL_MS: i64 = 15_000;

#[derive(Debug, Clone)]
pub struct Config {
    /// The libSQL endpoint, as Turso gives it.
    ///
    /// Accepted as either `libsql://` or `https://`: the dashboard shows the first and
    /// the client wants the second, and making a deployment fail over a scheme nobody
    /// chose is a poor use of an outage.
    pub database_url: String,
    pub database_token: String,
    pub jwt_secret: String,
    pub port: u16,
    pub simulator_enabled: bool,
    pub sample_interval_ms: i64,
    pub device_api_key: Option<String>,
}

fn required(key: &str) -> AppResult<String> {
    std::env::var(key).map_err(|_| AppError::MissingEnv(key.to_owned()))
}

fn parsed<T: std::str::FromStr>(key: &str, fallback: T) -> AppResult<T> {
    match std::env::var(key) {
        Err(_) => Ok(fallback),
        Ok(raw) => raw
            .parse::<T>()
            .map_err(|_| AppError::InvalidEnv(key.to_owned())),
    }
}

/// Accepts the scheme Turso displays and hands over the one the client needs.
fn normalize_libsql(url: &str) -> String {
    match url.strip_prefix("libsql://") {
        Some(rest) => format!("https://{rest}"),
        None => url.to_owned(),
    }
}

/// Normalises an optional secret so "set but blank" is indistinguishable from unset.
///
/// `env::var` returns `Ok("")` for a variable that exists with no value, which would
/// otherwise reach `DeviceAuth` as `Some("")` and match the empty `x-device-key`
/// header any caller can send, opening ingest to anyone. Trimming additionally saves
/// a key piped in from a file with a trailing newline from rejecting every ingest
/// with no diagnostic anywhere.
fn optional_secret(raw: Option<String>) -> Option<String> {
    raw.map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

impl Config {
    pub fn from_env() -> AppResult<Self> {
        Ok(Self {
            database_url: normalize_libsql(&required("DATABASE_URL")?),
            database_token: required("DATABASE_AUTH_TOKEN")?,
            jwt_secret: required("JWT_SECRET")?,
            port: parsed("PORT", 8080)?,
            simulator_enabled: parsed("SIMULATOR_ENABLED", true)?,
            sample_interval_ms: parsed("SAMPLE_INTERVAL_MS", DEFAULT_SAMPLE_INTERVAL_MS)?,
            device_api_key: optional_secret(std::env::var("DEVICE_API_KEY").ok()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_libsql, optional_secret};

    #[test]
    fn the_scheme_turso_displays_is_accepted() {
        assert_eq!(
            normalize_libsql("libsql://vital-adamskie.turso.io"),
            "https://vital-adamskie.turso.io"
        );
    }

    #[test]
    fn an_https_url_is_left_alone() {
        assert_eq!(
            normalize_libsql("https://vital-adamskie.turso.io"),
            "https://vital-adamskie.turso.io"
        );
    }

    #[test]
    fn a_blank_secret_is_the_same_as_an_unset_one() {
        // The bug this guards: `Some("")` reached the device extractor and compared
        // equal to the empty `x-device-key` header, so anyone could post readings.
        assert_eq!(optional_secret(Some(String::new())), None);
        assert_eq!(optional_secret(Some("   ".to_owned())), None);
        assert_eq!(optional_secret(None), None);
    }

    #[test]
    fn a_real_secret_survives_with_surrounding_whitespace_removed() {
        assert_eq!(
            optional_secret(Some("  s3cret\n".to_owned())),
            Some("s3cret".to_owned())
        );
        assert_eq!(
            optional_secret(Some("s3cret".to_owned())),
            Some("s3cret".to_owned())
        );
    }
}
