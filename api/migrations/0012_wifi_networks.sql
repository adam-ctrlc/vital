-- Multiple stored Wi-Fi networks. The board polls the full prioritised list and
-- fails over down it; the admin app selects the preferred one. At most one row may
-- be the compiled-in default and at most one may be selected, enforced by partial
-- unique indexes. Seeded from the old singleton device_config, which is then dropped.
create table if not exists wifi_networks (
    id bigint generated always as identity primary key,
    ssid text not null,
    password text not null default '',
    is_default boolean not null default false,
    selected boolean not null default false,
    updated_at timestamptz not null default now(),
    constraint wifi_networks_ssid_unique unique (ssid)
);

create unique index if not exists wifi_networks_one_default on wifi_networks (is_default) where is_default;
create unique index if not exists wifi_networks_one_selected on wifi_networks (selected) where selected;

-- Guarded because this migration reached the shared database out of band: the DDL
-- took effect but the _sqlx_migrations row was never written, so sqlx re-runs it
-- against a schema where device_config has already been dropped. Every other
-- statement here was written to tolerate that; this read was not, and it failed with
-- 42P01, which stopped the dev server before it could serve or apply 0013 and 0014.
-- A fresh database is unaffected: 0003 creates device_config, so the seed still runs.
do $$
begin
    if exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'device_config'
    ) then
        insert into wifi_networks (ssid, password, selected, updated_at)
        select wifi_ssid, wifi_password, true, updated_at from device_config where id = 1
        on conflict (ssid) do nothing;
    end if;
end $$;

drop table if exists device_config;
