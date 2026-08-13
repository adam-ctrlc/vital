use std::time::Duration;

use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

use crate::error::AppResult;

/// Small on purpose: every serverless instance opens its own pool, and a pooled
/// database counts each of those against one shared connection limit.
///
/// The session pooler allows 15 clients in total. At five apiece, three warm instances
/// were enough to take the whole budget, and every cold start after that failed to
/// build with `EMAXCONNSESSION`, which turns into a 500 on every route including the
/// ones that never touch the database.
/// One, not two. The pooler allows fifteen clients in total, so this is really a cap on
/// how many warm instances can exist at once: at two, eight of them exhaust the budget
/// and every cold start after that fails to build. Serverless handles one request at a
/// time in the common case, so the second connection bought concurrency that was rarely
/// used and cost half the fleet's headroom.
const MAX_CONNECTIONS: u32 = 1;

/// How long an unused connection is kept before it is handed back.
///
/// This is the part that actually matters. A serverless instance stays warm long after
/// it stops serving, and without a timeout it keeps its connections for that whole
/// time: the budget is consumed by instances doing nothing. Releasing when idle is what
/// lets a burst of traffic settle instead of locking the pool until the instances die.
const IDLE_TIMEOUT: Duration = Duration::from_secs(5);

/// A ceiling on any one connection's life, so a connection the pooler has quietly
/// dropped cannot sit in the pool being handed out forever.
const MAX_LIFETIME: Duration = Duration::from_secs(60);

/// Fail rather than hang when the pool is genuinely saturated. Ten seconds is far
/// longer than any query here, so reaching it means waiting will not help.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(10);

/// Connects the pool.
///
/// `DATABASE_URL` must point at a **session** pooler, not a transaction pooler.
/// sqlx names its prepared statements per connection (`sqlx_s_1`, `sqlx_s_2`, ...).
/// A transaction pooler multiplexes many connections onto shared backends, so two
/// connections both issue `sqlx_s_1` against the same backend and it fails with
/// `42P05 prepared statement "sqlx_s_1" already exists`, intermittently, on roughly
/// half of all requests. Disabling sqlx's statement cache does not help: it stops
/// statements being reused, not being named. A session pooler gives each connection
/// its own backend, which is what makes the names unique again.
pub async fn connect(database_url: &str) -> AppResult<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        // Nothing is held open just in case: an idle instance should cost the pooler
        // nothing at all.
        .min_connections(0)
        .idle_timeout(IDLE_TIMEOUT)
        .max_lifetime(MAX_LIFETIME)
        .acquire_timeout(ACQUIRE_TIMEOUT)
        .connect(database_url)
        .await?;

    Ok(pool)
}

/// Applies pending migrations. Only the local dev server calls this: production
/// runs serverless, where this would fire on every cold start. Dev and production
/// share the same database, so migrating from dev is what production picks up.
pub async fn migrate(pool: &PgPool) -> AppResult<()> {
    sqlx::migrate!("./migrations").run(pool).await?;

    Ok(())
}
