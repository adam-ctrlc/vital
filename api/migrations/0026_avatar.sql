-- Profile pictures, set by each person for their own account.
--
-- SQLite, run once against the existing database (schema.sql already has the column for
-- a fresh one). Not idempotent. Only adds a nullable column, so the API deployed before
-- this keeps working.

-- A data URL (data:image/webp;base64,...), compressed in the app to about 10-20 KB.
alter table users add column avatar text;
