-- Separates the alarm level from the trip level.
--
-- Until now one number did both jobs: load_threshold_va raised the alert and, on the
-- board, decided the overload state. Wiring the relay to that same number would mean
-- the warning and the disconnection land in the same instant, leaving nobody any
-- margin to respond. Protection normally wants two levels: an alarm somebody acts on,
-- and a trip that acts for them when nobody did.
--
-- 980 against the existing 900 alarm suits the 1 KVA unit this was built for: close
-- enough to the rating to be a real backstop, far enough above the alarm that an
-- operator gets a window first.
alter table settings
    add column if not exists trip_threshold_va double precision not null default 980;

-- The ordering is the whole point of having two, so it is enforced here rather than
-- left to whichever caller writes them next. A trip at or below the alarm would make
-- the alarm useless, and a trip below the load the alarm permits would open the relay
-- during normal operation.
alter table settings
    drop constraint if exists settings_trip_above_alarm;

alter table settings
    add constraint settings_trip_above_alarm check (trip_threshold_va > load_threshold_va);
