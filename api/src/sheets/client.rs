use std::collections::HashMap;
use std::sync::{Arc, Once};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::RwLock;

use crate::error::{AppError, AppResult};

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SHEETS_API: &str = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE: &str = "https://www.googleapis.com/auth/spreadsheets";

/// How long before expiry a cached token is treated as spent.
///
/// Google issues these for an hour. Renewing a minute early costs one extra exchange an
/// hour and removes the case where a token expires between being read and being used.
const RENEW_BEFORE_SECONDS: i64 = 60;

/// The service account, as Google issues it.
#[derive(Debug, Clone, Deserialize)]
pub struct ServiceAccount {
    pub client_email: String,
    pub private_key: String,
    #[serde(default = "default_token_uri")]
    pub token_uri: String,
}

fn default_token_uri() -> String {
    TOKEN_URL.to_owned()
}

#[derive(Debug, Serialize)]
struct Claims {
    iss: String,
    scope: String,
    aud: String,
    iat: i64,
    exp: i64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: i64,
}

#[derive(Debug, Clone)]
struct CachedToken {
    value: String,
    expires_at: DateTime<Utc>,
}

/// A spreadsheet, used as the database.
///
/// Sheets has no connection to hold, so unlike a pool this is only credentials and a
/// cached token. That is also why it is cheap to clone into the app state.
///
/// The token is cached per process, which on serverless means per warm instance. Each
/// one exchanges its own, so the cost is one extra call per instance per hour rather
/// than one per request.
#[derive(Clone)]
pub struct Sheets {
    http: reqwest::Client,
    creds: Arc<ServiceAccount>,
    spreadsheet_id: Arc<str>,
    token: Arc<RwLock<Option<CachedToken>>>,
    reads: Arc<RwLock<HashMap<String, (Instant, Vec<Vec<String>>)>>>,
}

impl Sheets {
    /// Builds a client from the service account JSON and the target spreadsheet.
    ///
    /// The JSON arrives as an environment variable rather than a file: there is nowhere
    /// to put a file on a serverless deploy, and a key on disk in a repository is how
    /// keys end up in public history.
    pub fn new(service_account_json: &str, spreadsheet_id: &str) -> AppResult<Self> {
        install_crypto_provider();

        let creds: ServiceAccount = serde_json::from_str(service_account_json)
            .map_err(|error| AppError::Config(format!("service account JSON is not valid: {error}")))?;

        Ok(Self {
            http: reqwest::Client::new(),
            creds: Arc::new(creds),
            spreadsheet_id: Arc::from(spreadsheet_id),
            token: Arc::new(RwLock::new(None)),
            reads: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    /// A bearer token, minted only when the cached one is missing or nearly spent.
    async fn token(&self) -> AppResult<String> {
        if let Some(cached) = self.token.read().await.as_ref() {
            if cached.expires_at > Utc::now() {
                return Ok(cached.value.clone());
            }
        }

        let mut guard = self.token.write().await;

        // Checked again under the write lock: several requests can find the token spent
        // at once, and without this they would all mint a new one.
        if let Some(cached) = guard.as_ref() {
            if cached.expires_at > Utc::now() {
                return Ok(cached.value.clone());
            }
        }

        let fresh = self.mint().await?;
        let value = fresh.value.clone();
        *guard = Some(fresh);

        Ok(value)
    }

    async fn mint(&self) -> AppResult<CachedToken> {
        let now = Utc::now().timestamp();
        let claims = Claims {
            iss: self.creds.client_email.clone(),
            scope: SCOPE.to_owned(),
            aud: self.creds.token_uri.clone(),
            iat: now,
            exp: now + 3600,
        };

        let key = EncodingKey::from_rsa_pem(self.creds.private_key.as_bytes())
            .map_err(|error| AppError::Config(format!("service account key is not usable: {error}")))?;
        let assertion = jsonwebtoken::encode(&Header::new(Algorithm::RS256), &claims, &key)
            .map_err(|error| AppError::Config(format!("could not sign the assertion: {error}")))?;

        // Built by hand rather than with reqwest's form helper, which lives behind a
        // feature this build does not enable. The grant type is a constant with colons
        // in it, and a JWT is base64url, so between them the only character needing an
        // escape is one that is always the same.
        let body = format!(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={assertion}"
        );

        let response = self
            .http
            .post(&self.creds.token_uri)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|error| AppError::Upstream(format!("could not reach Google for a token: {error}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();

            return Err(AppError::Upstream(format!("token request failed: {status} {body}")));
        }

        let token: TokenResponse = response
            .json()
            .await
            .map_err(|error| AppError::Upstream(format!("token response was not readable: {error}")))?;

        Ok(CachedToken {
            value: token.access_token,
            expires_at: Utc::now()
                + chrono::Duration::seconds((token.expires_in - RENEW_BEFORE_SECONDS).max(1)),
        })
    }

    async fn request<T: for<'de> Deserialize<'de>>(
        &self,
        method: reqwest::Method,
        url: String,
        body: Option<serde_json::Value>,
    ) -> AppResult<T> {
        let token = self.token().await?;
        let mut request = self.http.request(method, &url).bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }

        let response = request
            .send()
            .await
            .map_err(|error| AppError::Upstream(format!("could not reach Sheets: {error}")))?;

        let status = response.status();
        if !status.is_success() {
            let detail = response.text().await.unwrap_or_default();

            // 429 is the one worth naming. It is the failure this design is most likely
            // to meet, and "Sheets said no" would send someone looking in the wrong place.
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                return Err(AppError::Upstream(
                    "Sheets rate limit reached; the API is asking for data faster than Google allows"
                        .to_owned(),
                ));
            }

            return Err(AppError::Upstream(format!("Sheets returned {status}: {detail}")));
        }

        response
            .json()
            .await
            .map_err(|error| AppError::Upstream(format!("Sheets response was not readable: {error}")))
    }

    /// Every cell in a range, as rows of strings.
    ///
    /// Sheets omits trailing empty cells rather than padding them, so a row can come
    /// back shorter than its header. Callers read by index and must treat a missing
    /// cell as empty rather than assuming a rectangle.
    pub async fn values(&self, range: &str) -> AppResult<Vec<Vec<String>>> {
        #[derive(Deserialize)]
        struct ValueRange {
            #[serde(default)]
            values: Vec<Vec<String>>,
        }

        let url = format!(
            "{SHEETS_API}/{}/values/{}",
            self.spreadsheet_id,
            urlencoding(range)
        );
        let body: ValueRange = self.request(reqwest::Method::GET, url, None).await?;

        Ok(body.values)
    }

    /// Adds rows after the last one with content.
    pub async fn append(&self, range: &str, rows: Vec<Vec<String>>) -> AppResult<()> {
        let url = format!(
            "{SHEETS_API}/{}/values/{}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS",
            self.spreadsheet_id,
            urlencoding(range)
        );

        self.request::<serde_json::Value>(reqwest::Method::POST, url, Some(json!({ "values": rows })))
            .await?;

        Ok(())
    }

    /// Overwrites a range.
    pub async fn update(&self, range: &str, rows: Vec<Vec<String>>) -> AppResult<()> {
        let url = format!(
            "{SHEETS_API}/{}/values/{}?valueInputOption=RAW",
            self.spreadsheet_id,
            urlencoding(range)
        );

        self.request::<serde_json::Value>(reqwest::Method::PUT, url, Some(json!({ "values": rows })))
            .await?;

        Ok(())
    }

    /// A read served from memory when it was taken recently enough.
    ///
    /// This is what makes the design viable. Google allows sixty requests a minute per
    /// caller and the dashboard polls once a second, so without this a single open app
    /// would sit exactly on the ceiling and a second would exceed it. One fetch now
    /// serves every dashboard for the length of the window.
    ///
    /// Per process, which on serverless means per warm instance, so the real rate is
    /// the window divided by the number of live instances rather than by one.
    pub async fn values_cached(&self, range: &str, ttl: Duration) -> AppResult<Vec<Vec<String>>> {
        if let Some((taken_at, rows)) = self.reads.read().await.get(range) {
            if taken_at.elapsed() < ttl {
                return Ok(rows.clone());
            }
        }

        let rows = self.values(range).await?;
        self.reads
            .write()
            .await
            .insert(range.to_owned(), (Instant::now(), rows.clone()));

        Ok(rows)
    }

    /// Drops cached reads for a tab, after writing to it.
    ///
    /// Without this a write would be invisible for the length of the window, which for
    /// an ingest that raises an alert means the dashboard showing the old value while
    /// the phone is already ringing.
    pub async fn invalidate(&self, tab: &str) {
        self.reads.write().await.retain(|range, _| !range.starts_with(tab));
    }

    /// How many rows a tab has, including its header.
    pub async fn row_count(&self, tab: &str) -> AppResult<usize> {
        #[derive(Deserialize)]
        struct Grid {
            #[serde(rename = "rowCount")]
            row_count: usize,
        }
        #[derive(Deserialize)]
        struct Properties {
            title: String,
            #[serde(rename = "gridProperties")]
            grid_properties: Grid,
        }
        #[derive(Deserialize)]
        struct Sheet {
            properties: Properties,
        }
        #[derive(Deserialize)]
        struct Spreadsheet {
            #[serde(default)]
            sheets: Vec<Sheet>,
        }

        let url = format!(
            "{SHEETS_API}/{}?fields=sheets.properties(title,gridProperties.rowCount)",
            self.spreadsheet_id
        );
        let body: Spreadsheet = self.request(reqwest::Method::GET, url, None).await?;

        Ok(body
            .sheets
            .into_iter()
            .find(|sheet| sheet.properties.title == tab)
            .map_or(0, |sheet| sheet.properties.grid_properties.row_count))
    }

    /// The last rows of a tab, without reading the whole thing.
    ///
    /// A month of readings is a quarter of a million rows and the dashboard wants the
    /// newest one. Asking for a bounded range near the end costs two small calls
    /// instead of one enormous one.
    ///
    /// The row count is the allocated grid height rather than the number of rows with
    /// content, so the window can land past the data and come back short. That is fine:
    /// the caller takes the last row that parses.
    pub async fn tail(&self, tab: &str, last_column: char, rows: usize) -> AppResult<Vec<Vec<String>>> {
        let height = self.row_count(tab).await?;
        // Row 1 is the header, so never start above row 2.
        let start = height.saturating_sub(rows).max(2);
        let range = format!("{tab}!A{start}:{last_column}{height}");

        self.values(&range).await
    }

    /// The tabs the spreadsheet currently has.
    pub async fn tabs(&self) -> AppResult<Vec<String>> {
        #[derive(Deserialize)]
        struct Properties {
            title: String,
        }
        #[derive(Deserialize)]
        struct Sheet {
            properties: Properties,
        }
        #[derive(Deserialize)]
        struct Spreadsheet {
            #[serde(default)]
            sheets: Vec<Sheet>,
        }

        let url = format!(
            "{SHEETS_API}/{}?fields=sheets.properties.title",
            self.spreadsheet_id
        );
        let body: Spreadsheet = self.request(reqwest::Method::GET, url, None).await?;

        Ok(body.sheets.into_iter().map(|sheet| sheet.properties.title).collect())
    }

    /// Creates a tab, with its header row, unless it is already there.
    ///
    /// Used by the monthly rollover, which cannot know in advance which month it will
    /// be asked for.
    pub async fn ensure_tab(&self, title: &str, header: &[&str]) -> AppResult<()> {
        if self.tabs().await?.iter().any(|existing| existing == title) {
            return Ok(());
        }

        let url = format!("{SHEETS_API}/{}:batchUpdate", self.spreadsheet_id);
        self.request::<serde_json::Value>(
            reqwest::Method::POST,
            url,
            Some(json!({
                "requests": [{ "addSheet": { "properties": { "title": title } } }]
            })),
        )
        .await?;

        self.update(
            &format!("{title}!A1"),
            vec![header.iter().map(|column| (*column).to_owned()).collect()],
        )
        .await?;

        tracing::info!(tab = title, "created a sheet tab");

        Ok(())
    }
}

/// Installs the TLS backend, once per process.
///
/// reqwest is built here without a default provider, so a client constructed before one
/// is installed panics. Kept beside the only thing in this module that builds a client,
/// rather than left as something every caller has to remember.
fn install_crypto_provider() {
    static ONCE: Once = Once::new();

    ONCE.call_once(|| {
        // Errs only if another provider won the race, which is the same outcome.
        drop(rustls::crypto::ring::default_provider().install_default());
    });
}

/// Percent-encodes a range for a URL path.
///
/// Ranges carry `!` and can carry spaces or a quoted tab name, none of which survive a
/// path segment unescaped. Written out rather than pulled in: it is three characters
/// that matter and a dependency to avoid.
fn urlencoding(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '!' => "%21".to_owned(),
            ' ' => "%20".to_owned(),
            '\'' => "%27".to_owned(),
            '#' => "%23".to_owned(),
            other => other.to_string(),
        })
        .collect()
}
