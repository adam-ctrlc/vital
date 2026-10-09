-- The limits each reading was judged against, a relay command the board acknowledges,
-- and why the board last restarted.
--
-- SQLite, run once against the existing database (schema.sql already has these columns
-- for a fresh one). Not idempotent: SQLite has no `add column if not exists`. Only adds
-- nullable or defaulted columns, so the API deployed before this keeps working after it.

-- The limits in force when the row was recorded. A status of overload only means
-- something next to the alarm it was measured against, and the operator can move the
-- alarm at any time. Older rows stay null: no history of the settings was kept.
alter table readings add column load_threshold_va real;
alter table readings add column trip_threshold_va real;
alter table readings add column temp_threshold_c real;

-- Each relay request gets the next id. The board echoes back the highest id it has
-- applied, and the command is cleared only then, so a response lost on the way to the
-- board no longer loses the command with it.
alter table device_telemetry add column relay_command_id integer not null default 0;
-- When the pending command was requested. One older than a minute is dropped rather
-- than delivered, so a board that was away does not act on a stale intent.
alter table device_telemetry add column relay_command_at text;

-- Why the board last restarted, as it reported on its heartbeat: "brownout" tells a
-- power dip apart from a crash or a watchdog reset.
alter table device_telemetry add column reset_reason text;
