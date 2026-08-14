-- The whole schema, as SQLite understands it.
--
-- One file rather than the twenty two incremental migrations it came from. Those exist
-- to move a database that already has data from one shape to another; this database
-- starts empty, and replaying two years of decisions to arrive at the current shape
-- would only be a way to get it wrong.
--
-- Three translations run through everything:
--
--   * Timestamps are text in RFC 3339, always UTC, always with the Z. SQLite has no
--     date type, and `datetime('now')` yields "2026-08-14 05:00:00" which chrono will
--     not parse: no T, no zone. `strftime('%Y-%m-%dT%H:%M:%fZ','now')` is the same
--     instant in a form that round trips.
--   * Uuids are text. There is no uuid type, and text is what a uuid already is on the
--     wire.
--   * Booleans are integers, 0 and 1, which is what SQLite stores anyway.
--
-- Everything else survives. SQLite has check constraints, partial unique indexes and
-- foreign keys, so nothing about what the database refuses had to be given up.

create table if not exists users (
    id            text primary key,
    -- Nullable: an account can exist without one, and the app allows it.
    email         text unique,
    username      text not null unique,
    password_hash text not null,
    role          text not null check (role in ('admin', 'user')),
    first_name    text not null default '',
    middle_name   text,
    last_name     text not null default '',
    created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists readings (
    id                integer primary key autoincrement,
    -- Every measurement is nullable. A board reports what it can read, and a missing
    -- sensor must be distinguishable from a reading of zero.
    voltage_v         real,
    current_a         real,
    temperature_c     real,
    apparent_power_va real,
    power_w           real,
    power_factor      real,
    frequency_hz      real,
    energy_kwh        real,
    -- Whether the relay was passing load when this was measured. Null for a simulated
    -- reading, which has no contacts to report.
    relay_closed      integer,
    status            text not null check (status in ('normal', 'overload')),
    source            text not null default 'simulator',
    recorded_at       text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    created_at        text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at        text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists readings_recorded_at_idx on readings (recorded_at desc);
create index if not exists readings_source_recorded_at_idx on readings (source, recorded_at desc);

create table if not exists alerts (
    id               integer primary key autoincrement,
    -- `set null` rather than the default, which is to refuse. An alert is a record of
    -- something that happened and outlives the row that triggered it; blocking the
    -- delete instead would make the reading undeletable for as long as the alert
    -- exists, which is forever.
    reading_id       integer references readings (id) on delete set null,
    kind             text not null check (kind in ('overload', 'temperature')),
    message          text not null,
    value            real not null,
    threshold        real not null,
    created_at       text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    acknowledged_at  text,
    -- Likewise. Without `set null` this refuses, and deleting any user who had ever
    -- acknowledged an alert failed with a foreign key error and a 500. Losing who
    -- acknowledged it is the right trade: the alert, its time and its response are
    -- the record worth keeping, and an account that no longer exists cannot be named.
    acknowledged_by  text references users (id) on delete set null,
    response_ms      integer,
    -- When a device was last told, as distinct from when the alert opened. An alarm
    -- that speaks once and goes quiet while the fault continues is not an alarm.
    last_notified_at text,
    updated_at       text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists alerts_created_at_idx on alerts (created_at desc);
create index if not exists alerts_active_idx on alerts (acknowledged_at) where acknowledged_at is null;

-- At most one unacknowledged alert per kind.
--
-- The guard that stops one ongoing overload pushing to every phone every few seconds.
-- The service checks before inserting, but a check and an insert are two statements and
-- concurrent requests can both pass; this is what makes the second one fail instead.
-- SQLite supports partial unique indexes, so this crossed over intact.
create unique index if not exists alerts_one_active_per_kind
    on alerts (kind) where acknowledged_at is null;

create table if not exists settings (
    id                    integer primary key check (id = 1),
    load_threshold_va     real not null default 900,
    trip_threshold_va     real not null default 980,
    temp_threshold_c      real not null default 40,
    reclose_delay_seconds integer not null default 30
        check (reclose_delay_seconds between 5 and 600),
    -- How long the load must stay above the trip level before the contacts open.
    --
    -- Not the same wait as the one above, and easy to confuse: this one runs while the
    -- load is still connected and decides whether to cut it, the other runs while it is
    -- disconnected and decides when to try again.
    --
    -- The floor is 1 rather than 0 because a transformer draws several times its rated
    -- current for a fraction of a second at switch-on. At 0 the board would cut the
    -- load on that inrush every time it closed, and never get past it.
    trip_confirm_seconds  integer not null default 3
        check (trip_confirm_seconds between 1 and 60),
    source_mode           text not null default 'hardware',
    created_at            text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at            text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- The trip must sit above the alarm or the two stages collapse into one: the relay
    -- would open in the same instant the alert was raised, leaving nobody a window to
    -- shed load first.
    check (trip_threshold_va > load_threshold_va)
);

insert or ignore into settings (id) values (1);

create table if not exists device_telemetry (
    id               integer primary key check (id = 1),
    device_id        text,
    firmware         text,
    ssid             text,
    ip_address       text,
    signal_dbm       integer,
    uptime_seconds   integer,
    -- What an operator has asked the relay to do, waiting for the board to come and ask.
    relay_command    text check (relay_command is null or relay_command in ('open', 'close')),
    relay_locked_out integer not null default 0,
    reported_at      text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

insert or ignore into device_telemetry (id) values (1);

create table if not exists push_tokens (
    token      text primary key,
    user_id    text not null references users (id) on delete cascade,
    platform   text not null default 'unknown',
    channel_id text,
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists push_tokens_user_id_idx on push_tokens (user_id);
