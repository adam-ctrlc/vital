-- Two invariants that concurrency was quietly breaking, plus the index both live
-- lookups have always wanted.
--
-- 1. At most one unacknowledged alert per kind.
--
-- alerts::service::raise checks for an active alert before inserting, but the check and
-- the insert are separate statements, so concurrent requests all read "none active" and
-- all insert. Every duplicate also pushed a notification to every registered device,
-- which is exactly the alarm fatigue that guard exists to prevent. Simulation mode made
-- this routine rather than rare: the dashboard polls once a second from every open app,
-- and each poll could record a reading and evaluate alerts against it.
--
-- Existing duplicates have to be resolved first, since the index cannot be built while
-- they coexist. The newest of each kind stays active and the rest are marked
-- acknowledged with no responder and no response time, which is how the app already
-- renders an alert that nobody claimed.
update alerts a
set acknowledged_at = now()
where a.acknowledged_at is null
  and exists (
      select 1
      from alerts b
      where b.kind = a.kind
        and b.acknowledged_at is null
        and (b.created_at, b.id) > (a.created_at, a.id)
  );

create unique index if not exists alerts_one_active_per_kind
    on alerts (kind) where acknowledged_at is null;

-- 2. An index matching the shape both live lookups actually use.
--
-- Serving the dashboard means finding the newest row of one source: 'hardware' for the
-- live reading, 'simulator' for deciding whether a sample is due. readings_recorded_at_idx
-- covers the ordering but not the filter, so each lookup walked back through the other
-- feed's rows to reach its own. On a table designed to grow forever, on the query that
-- runs once a second per viewer, that is the one worth indexing properly.
create index if not exists readings_source_recorded_at_idx
    on readings (source, recorded_at desc);
