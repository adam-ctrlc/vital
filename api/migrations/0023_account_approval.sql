-- Self-registration, held until an admin approves it.
--
-- A new account from the sign-in page starts 'pending' and cannot sign in until an admin
-- approves it, which sets it 'active'. The default is 'active', so every existing account,
-- and every account an admin creates, is unaffected.
--
-- SQLite, run once against the existing database (schema.sql already has the column for a
-- fresh one). Not idempotent: SQLite has no `add column if not exists`.
alter table users add column status text not null default 'active' check (status in ('pending', 'active'));
