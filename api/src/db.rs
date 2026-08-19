use libsql::{Builder, Connection, Database, Row};

use crate::error::{AppError, AppResult};

/// The database, reached over HTTP.
///
/// There is no pool here and nothing to size, which is the point. The Postgres build
/// spent two outages on connection budget: a session pooler allows fifteen clients, a
/// warm serverless instance holds its connections long after it stops serving, and once
/// a handful of idle instances held the lot every cold start failed to build and
/// returned 500 on every route, including ones that never touch the database.
///
/// libSQL over HTTP has no such budget. Each request is a request, so an instance that
/// is doing nothing costs nothing, and there is no ceiling to exhaust.
pub struct Db {
    database: Database,
}

impl Db {
    /// Opens the remote database.
    ///
    /// Cheap, and deliberately not verified here. `Builder` does no round trip, so a
    /// bad URL or an expired token surfaces on the first query rather than at startup.
    /// Failing at startup would be tidier, but it would also mean a cold start paying
    /// for a health check that the first request performs anyway.
    pub async fn connect(url: &str, token: &str) -> AppResult<Self> {
        let database = Builder::new_remote(url.to_owned(), token.to_owned())
            .build()
            .await
            .map_err(|error| AppError::Config(format!("could not open the database: {error}")))?;

        Ok(Self { database })
    }

    /// A connection for one piece of work.
    ///
    /// Not pooled and not held: over HTTP a connection is a handle rather than a socket,
    /// so making one per request is the intended shape rather than a waste.
    pub fn conn(&self) -> AppResult<Connection> {
        self.database
            .connect()
            .map_err(|error| AppError::Upstream(format!("could not reach the database: {error}")))
    }
}

/// Takes the first row of a result set, then finishes the rest.
///
/// Over HTTP a result set is a statement still open on the stream. Abandoning one half
/// read leaves the stream in a state the server refuses further requests on, and the
/// next query fails with "stream not found: <id>" — which reads like the database went
/// away rather than like the previous statement was never finished.
///
/// It only bites when another query follows on the same connection, so every
/// `returning` that ends its request got away with it. Ingest did not: it inserts a
/// reading and then evaluates alerts, and that second query is reached only by a
/// reading that actually crosses a threshold. The fault was therefore invisible until
/// one did, and would have taken out every alert the moment the meter reported a real
/// overload.
pub async fn first_row(rows: &mut libsql::Rows) -> AppResult<Option<Row>> {
    let first = rows.next().await?;
    while rows.next().await?.is_some() {}

    Ok(first)
}

/// Applies the schema.
///
/// One file rather than a migration chain. The chain existed to carry a database that
/// already had data from one shape to another; this one is created in its final shape,
/// and every statement is `if not exists`, so running it twice is not an error.
///
/// Called by `cargo run --bin migrate`, never by the server. On serverless this would
/// otherwise run on every cold start, which is fourteen statements of nothing.
pub async fn apply_schema(conn: &Connection, schema: &str) -> AppResult<usize> {
    let mut applied = 0;

    for chunk in schema.split(";\n") {
        // Comment lines are stripped rather than used to skip the chunk. Every statement
        // in the schema is preceded by an explanation of why it is shaped the way it is,
        // so discarding commented chunks discards most of the schema. That exact mistake
        // once reported fourteen statements applied while silently creating twelve.
        let statement: String = chunk
            .lines()
            .filter(|line| !line.trim_start().starts_with("--"))
            .collect::<Vec<_>>()
            .join("\n");

        if statement.trim().is_empty() {
            continue;
        }

        conn.execute(statement.trim(), ())
            .await
            .map_err(|error| AppError::Upstream(format!("schema failed: {error}")))?;
        applied += 1;
    }

    Ok(applied)
}
