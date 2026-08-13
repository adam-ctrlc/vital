-- When a device was last told about an alert, as distinct from when the alert opened.
--
-- An alert is raised once per condition so the list does not fill with duplicates, and
-- until now the notification followed that same rule: one push, ever. A transformer
-- sitting above its threshold therefore announced itself once and then went silent,
-- which is the opposite of what an alarm is for.
--
-- Kept on the alert rather than derived from created_at because the two answer different
-- questions: one is when the condition began, the other is when someone was last told
-- it is still going.
alter table alerts add column if not exists last_notified_at timestamptz;

-- Existing open alerts count as notified when they were raised, which is true: they
-- were. Without this they would all re-announce at once on the next reading.
update alerts set last_notified_at = created_at where last_notified_at is null;
