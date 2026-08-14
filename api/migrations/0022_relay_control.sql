-- The relay's position, the operator's ability to argue with it, and how long it waits
-- before trying again.
--
-- Until now nothing about the relay reached the database. The alerts table recorded that
-- a load crossed a threshold; nothing recorded that the protection acted on it. For a
-- scheme whose whole purpose is opening a contact, the opening was the one event with no
-- history at all.
--
-- On every reading rather than a separate event log: the position is a property of the
-- moment a measurement was taken, and storing it alongside gives the timeline for free,
-- including the amps that were flowing when it opened.
alter table readings add column if not exists relay_closed boolean;

-- What an operator has asked the relay to do, waiting for the board to come and ask.
--
-- A request rather than a call because there is no route to the board: it lives on
-- someone's Wi-Fi behind whatever NAT and speaks only outward. It asks on its heartbeat,
-- and the answer is waiting when it does. Read and cleared in one statement, so a
-- command is handed over exactly once however many heartbeats arrive together.
alter table device_telemetry add column if not exists relay_command text;
alter table device_telemetry add column if not exists relay_locked_out boolean not null default false;

-- Only the two commands, so a typo becomes an error here rather than silence on the board.
alter table device_telemetry drop constraint if exists device_telemetry_relay_command_check;
alter table device_telemetry add constraint device_telemetry_relay_command_check
    check (relay_command is null or relay_command in ('open', 'close'));

-- How long the board waits before each reclose attempt.
--
-- An operator setting rather than a constant in the firmware: how long a transformer
-- should sit disconnected before trying again depends on the transformer, and changing
-- it should not need a reflash. It travels on the heartbeat with the thresholds.
alter table settings add column if not exists reclose_delay_seconds integer not null default 30;

-- Wide enough to be useful, narrow enough that a bad value cannot disable the wait
-- entirely or park the load off for a day.
alter table settings drop constraint if exists settings_reclose_delay_check;
alter table settings add constraint settings_reclose_delay_check
    check (reclose_delay_seconds between 5 and 600);
