//! The spreadsheet, used as the database.
//!
//! Sheets is not a database and this module does not pretend otherwise. There are no
//! transactions, no unique indexes and no locks, so the guarantees those provide are
//! either enforced above this layer or accepted as lost. Where one is lost, the code
//! that depends on it says so.
pub mod client;
pub mod schema;
pub mod store;

pub use client::{ServiceAccount, Sheets};
