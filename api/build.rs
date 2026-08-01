//! Rebuild when a migration is added or edited.
//!
//! `sqlx::migrate!` embeds the SQL into the binary at compile time, and cargo has no
//! way to know a `.sql` file matters unless it is told. Without this, adding a
//! migration and running the dev server starts cleanly, reports nothing, and silently
//! skips it: the binary still holds the previous set. That failure looks exactly like
//! success, which is the worst way for it to behave.
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
