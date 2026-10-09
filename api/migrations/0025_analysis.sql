-- The analysis screens: the electricity rate and nominal voltage they are computed
-- against, and an audit trail of who changed what.
--
-- SQLite, run once against the existing database (schema.sql already has these for a
-- fresh one). Not idempotent: SQLite has no `add column if not exists`. Only adds
-- defaulted columns and a new table, so the API deployed before this keeps working.

-- Pesos per kWh, for the estimated cost of the energy used.
alter table settings add column energy_rate_per_kwh real not null default 12
    check (energy_rate_per_kwh >= 0 and energy_rate_per_kwh <= 1000);
-- What the supply should read, for judging sags and swells and sizing a capacitor.
alter table settings add column nominal_voltage_v real not null default 120
    check (nominal_voltage_v >= 50 and nominal_voltage_v <= 500);

-- One row per change an operator made. actor_name is copied in so the record still
-- reads after the account is renamed or deleted; detail is JSON.
create table if not exists audit_events (
    id         integer primary key autoincrement,
    at         text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    actor_id   text references users (id) on delete set null,
    actor_name text,
    action     text not null,
    target     text,
    detail     text
);
create index if not exists audit_events_at_idx on audit_events (at desc);
