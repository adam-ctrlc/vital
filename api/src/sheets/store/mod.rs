//! The data access layer, backed by the spreadsheet.
//!
//! One module per domain, each mirroring the operations the services used to run
//! against Postgres. The signatures match so the services change only in what they
//! are handed, not in what they ask for.
pub mod alerts;
pub mod device;
pub mod push;
pub mod readings;
pub mod settings;
pub mod users;
