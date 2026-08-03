-- Makes the ESP32 the default data source rather than the simulation.
--
-- The simulation exists so the system can be demonstrated before the board is wired
-- in. That is the exception now, not the starting point, so a fresh install should
-- come up expecting hardware and show "No data" until the board reports, rather than
-- showing convincing numbers that were never measured.
--
-- Both halves are needed. Changing the column default alone would not help a fresh
-- database: 0001 inserts the settings row before 0010 adds this column, so 0010
-- backfills the existing row to 'simulation' and the new default never applies to it.
alter table settings alter column source_mode set default 'hardware';

update settings set source_mode = 'hardware' where id = 1;
