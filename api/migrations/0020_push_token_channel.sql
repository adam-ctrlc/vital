-- Which notification channel a device wants its alerts delivered on.
--
-- Android takes a notification's sound from its channel and freezes it at creation, so
-- the app ships one channel per tone and picking a tone means picking a channel. The
-- server has to name that channel in the push or Android falls back to the default one,
-- which is why a chosen tone played in the app but never once it was closed.
--
-- Nullable: a device that registered before this, or one on iOS, has no channel and
-- falls back to the default.
alter table push_tokens add column if not exists channel_id text;
