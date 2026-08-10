# Vital

A Transformer Alert Management System for a 1 KVA distribution transformer, built as an electrical engineering thesis project at PHINMA Cagayan de Oro College, Carmen Campus.

An ESP32 measures the transformer and reports it to a Rust API, which stores every sample, raises alerts when a reading crosses a threshold, and serves live readings to an Expo app. The board also protects the transformer itself, opening a relay when the load runs away. The API can simulate the transformer from the clock, so the whole system can be demonstrated end to end with or without the hardware wired in.

## What it does

- Live monitoring of voltage, current, temperature and apparent power, with an animated AC waveform
- **Two-stage load protection**: an alarm at **900 VA** raises an alert, and a trip at **980 VA** opens the relay. Temperature alarms at **40 °C** but does not trip
- Alerts carry acknowledgement and response time, and the reading that triggered them, so a card shows how the transformer reached the threshold rather than only the value that crossed it
- Push notifications with a choice of **30 bundled tones**, a vibration pattern, and an alert length up to ten minutes. Everything is per device and can be switched off entirely
- Historical logs with server-side search, source and status filtering, and pagination, plus a daily load trend
- A data-source switch between a live ESP32 (the default) and the built-in simulation; hardware readings only show while the board is reporting, otherwise the dashboard reads "No data"
- Real device telemetry (IP, signal, uptime, firmware) reported by the board itself
- Configurable thresholds and full account management
- Two roles, decided by the account rather than a picker at sign-in

| Role | Who | Can reach |
|---|---|---|
| `admin` | Maintenance engineers | Everything: dashboard, alerts, logs, settings, users |
| `user` | Power utility personnel | Dashboard and alerts only |

## Architecture

```
ESP32  ──POST /readings + /device/heartbeat──>  Rust API  ──>  PostgreSQL
   (x-device-key)                                  │
Expo app  ──polls, bearer token───────────────────┘
```

The API is stateless. Serverless functions cannot keep a background loop alive, so in simulation mode readings are a pure function of the clock, and a sample is persisted only when the newest stored row is older than `SAMPLE_INTERVAL_MS`. In hardware mode the ESP32 pushes readings and the API serves the latest one while it stays fresh.

## Tech stack

**API** Rust, Axum 0.8, sqlx 0.8 against PostgreSQL (a session pooler is required), JWT (HS256) auth, argon2 password hashing. Deployed to Vercel in the `sin1` region, co-located with the database.

**App** Expo SDK 54, Expo Router, React Native 0.81, NativeWind (Tailwind), React Native Reusables, react-native-reanimated and react-native-svg for the waveform and charts, Phosphor icons, KaTeX pre-rendered offline for the formulas.

**Firmware** ESP32 reading a PZEM-004T v3 energy meter and a DS18B20 contact temperature probe, tripping a relay, and driving a 20x4 I2C LCD. Header-only C++ with one class per component, ArduinoJson for every payload it builds or reads.

## Project structure

```
api/            Rust API
  src/          one module per domain: auth, readings, alerts, settings, device, users
  migrations/   SQL, applied in development and shared with production
  api/index.rs  Vercel serverless entrypoint
app/            Expo application
  src/app/      Expo Router routes; (tabs) holds the screens
  src/features/ API clients and types, split by domain
  src/components/
esp32/          firmware (see esp32/structure.txt and esp32/pins.txt)
  esp32.ino     mode selector: REAL_MODE, plus DS18B20 / LCD / PZEM / backend tests
  src/          config, hardware, net, core, tests (header-only classes)
```

## Getting started

### API

Create `api/.env`:

```
DATABASE_URL=postgres://...      # a session pooler, not a transaction pooler
JWT_SECRET=a-long-random-string
DEVICE_API_KEY=a-long-random-string
PORT=8080

# Read by the seeder only, never by the server.
SEED_ADMIN_PASSWORD=...
SEED_USER_PASSWORD=...
```

```bash
cd api
cargo run
```

The development server applies migrations on start. Production never migrates: both share one database, so running the development server (or a one-off connection) is how production picks up a new migration.

### Accounts

There are no accounts until you create one, and **the seeder is not committed**: this repository is public, and the accounts it creates are the live ones, since development and production share a database. Create `api/src/bin/seed.rs`, which cargo discovers automatically:

```rust
use dynavolt_api::auth::{Role, password};
use dynavolt_api::config::Config;
use dynavolt_api::db;
use dynavolt_api::error::{AppError, AppResult};

#[tokio::main]
async fn main() -> AppResult<()> {
    dotenvy::dotenv().ok();

    // From the environment, never a literal. The insert below reapplies the password
    // on every run, so a password written here would silently undo any rotation.
    let password_plain = std::env::var("SEED_ADMIN_PASSWORD")
        .map_err(|_| AppError::MissingEnv("SEED_ADMIN_PASSWORD".to_owned()))?;

    let pool = db::connect(&Config::from_env()?.database_url).await?;

    sqlx::query(
        "insert into users (email, username, password_hash, role, first_name, last_name)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (email) do update set password_hash = excluded.password_hash",
    )
    .bind("you@example.com")
    .bind("you")
    .bind(password::hash(&password_plain)?)
    .bind(Role::Admin.as_str())
    .bind("Your")
    .bind("Name")
    .execute(&pool)
    .await?;

    Ok(())
}
```

> The Rust crate is named `dynavolt_api` for continuity with the deployment; the product is Vital. Renaming the crate is a separate, deploy-affecting change.

```bash
cargo run --bin seed
```

Further accounts can be created and edited from the app by an admin. Sign in with an email or a username.

### App

Create `app/.env`:

```
EXPO_PUBLIC_API_URL=http://localhost:8080/api/v1
```

```bash
cd app
pnpm install
pnpm expo start
```

Open it in Expo Go (SDK 54), or build a standalone APK with EAS (`eas build -p android --profile preview`) for the real app icon and push notifications. The bundled alert tones need a build too: the Expo config plugin copies them into the Android resources at prebuild, so in Expo Go they can be previewed but will not play once the app is closed. A phone cannot reach `localhost`, so point `EXPO_PUBLIC_API_URL` at your machine's LAN address or a deployed API.

### Firmware

Copy `esp32/secrets.example.h` to `esp32/secrets.h` (gitignored) and fill in `WIFI_SSID`, `WIFI_PASSWORD`, `BACKEND_URL` and `DEVICE_KEY` (the key must match the API's `DEVICE_API_KEY`). Install the libraries listed in `esp32/structure.txt` (hd44780, OneWire, DallasTemperature, PZEM004Tv30, and **ArduinoJson 7 or newer**), pick a mode at the top of `esp32.ino`, and flash. `esp32/pins.txt` documents the wiring.

Flash `TEST_MODE = TEST_LCD` first. Its ruler screen fills all four rows to twenty columns, so a blank row or column means the configured geometry does not match the panel.

## API

Everything is under `/api/v1`. All routes except `/health` and `/auth/login` need a bearer token, except the ingest and device endpoints, which authenticate with the `x-device-key` header.

| Route | Method | Access | Notes |
|---|---|---|---|
| `/health` | GET | public | Check time, UTC and local |
| `/auth/login` | POST | public | Email or username; returns a token and the account. Rate limited per caller |
| `/auth/me` | GET / PUT | any | Read or update the current account |
| `/auth/password` | PUT | any | Change own password |
| `/readings/latest` | GET | any | Live reading plus thresholds and link state |
| `/readings` | GET | admin | Paginated history; `q`, `status`, `source`, `limit`, `offset` |
| `/readings` | POST | device key | Hardware ingest; any subset of the fields |
| `/readings/trend` | GET | admin | Daily averages; `days` |
| `/alerts` | GET | any | Paginated; `q`, `kind`, `active`, `limit`, `offset` |
| `/alerts/{id}/ack` | POST | any | Acknowledge, recording response time |
| `/settings` | GET / PUT | any / admin | Alarm, trip and temperature thresholds |
| `/settings/source` | PUT | admin | Switch simulation or hardware |
| `/device/status` | GET | **admin** | Live link state and telemetry |
| `/device/heartbeat` | POST | device key | Board reports its IP, signal, uptime, firmware |
| `/notifications/register` | POST | any | Store this device's push token and chosen channel |
| `/notifications/unregister` | POST | any | Drop it, so a signed-out device stops being notified |
| `/users` | GET / POST | admin | List and create |
| `/users/{id}` | PUT / DELETE | admin | Edit or remove |

List endpoints return `{ rows, total, limit, offset }`. `total` counts every row matching the filters, not just the returned window.

### Readings

An ingest may carry any subset of the fields, so a board with only a temperature probe still reports:

```json
{ "temperatureC": 31.5 }
```

A fully wired board reports:

```json
{
  "voltageV": 230.1, "currentA": 3.2, "temperatureC": 31.5,
  "powerW": 690.2, "powerFactor": 0.94, "frequencyHz": 60.01, "energyKwh": 12.5
}
```

A reading with nothing in it at all is rejected with a 400 rather than stored: a row of nothing but nulls is indistinguishable from a gap in the record, and it would count towards the sample interval while carrying no measurement.

Missing measurements are stored as null and shown as "No data" in the app. Apparent power is derived as `S = V * I` when both are present. Reactive power is derived from the power triangle, `Q = sqrt(S^2 - P^2)`, only when real power was measured.

### Protection

Two load levels, and they do different things.

| Level | Default | Effect |
|---|---|---|
| Alarm | 900 VA | Raises an alert, marks the reading as an overload. Nothing is switched |
| Trip | 980 VA | Opens the relay after the load holds above it for 3 s |

The relay closes again once the load is back at or under the **alarm** level and at least 30 seconds have passed since the trip. Reclosing at the alarm rather than a fixed percentage below the trip makes the deadband the operator's own two numbers, and the trip-above-alarm rule that the API, the app and the firmware each enforce is what guarantees it is never zero.

Two deliberate choices worth knowing:

- **This runs on the board**, not in the API, so the transformer stays protected with the Wi-Fi down or the app closed. A trip is written to NVS and survives a reboot, because a fault is exactly the condition that browns out the supply.
- **A missing measurement holds the trip.** If the meter stops answering while tripped, the board will not reclose: it cannot confirm the fault is gone. Temperature alarms but never trips, since 40 °C is an advisory level for a transformer rather than a damage limit, and tripping on ambient warmth would be a nuisance.

## Notifications

Each device chooses a tone, a vibration pattern and how long an alert buzzes for. All three are stored on the phone; only the tone reaches the server, and only because of how Android works.

**Android takes a notification's sound from its channel, and freezes a channel's settings when it is created.** A channel's sound can never be changed afterwards, so choosing a tone means choosing a *different channel*, and the app registers one per tone at startup. They appear individually in the phone's own notification settings, which is also where someone can override the app's choice. Once they do, the app cannot override it back.

That has a consequence worth stating plainly, because the two look identical until the app is closed:

| | With the app open | With the app closed |
|---|---|---|
| Bundled tone | The app plays the file | Android plays it, from the channel |
| Vibration pattern | The app drives the vibrator | Fixed by the channel, not the picker |
| An uploaded file | The app plays it | Not possible: Android will not take a file the user picked |

Because a remote push is composed on the server, the chosen channel travels with the push token and is re-registered whenever the tone changes. A push naming no channel lands on the default one, which is the old behavior and what an iOS device or an older client still gets.

The tones are generated, not shipped as recordings: `app/scripts/build-alert-sounds.mjs` synthesizes all thirty as WAV files from sine, square, noise and struck-bell primitives. They sit between roughly 1 and 3 kHz, which is where a phone speaker is loudest and where a tone still carries across a room with a transformer humming in it. Regenerating is deterministic, so the files do not churn in every commit.

Each one runs for **12 seconds**, the motif repeating with a breath between passes rather than being stretched. That length is not cosmetic: with the app closed, Android plays the channel's sound exactly once and will not loop it, so whatever is in the file is the entire alarm. A quarter of a second reads as a ping; this reads as something wanting attention. They are written at 22.05 kHz because the highest partial any of them carries is under 5 kHz, which halves thirty files that are now twelve seconds each.

Where the app can schedule notifications itself, it posts a fresh one as each tone finishes, for as many passes as the chosen length needs. A remote push cannot do this: it is composed on the server, and a serverless function cannot hold a timer to send follow-ups, so a real alert arriving at a closed app is one twelve second tone.

**Tapping a notification stops the alarm.** Everything still queued is cancelled, the buzz stops, the tray is cleared, and the alert is acknowledged. Acknowledging from the notification rather than only from the Alerts screen means the response time measures reaching for the phone, not navigating the app afterwards.

**Profile has a Test button** that schedules real notifications a few seconds out, covering the chosen alert length, and turns into a Stop while they are queued: covering ten minutes schedules fifty of them, and without a way to call them off the only way to end a test would be to sit through it. Preview cannot demonstrate the closed case: it plays the file in process, so it stops when the app goes to the background, while the vibration, a system call, carries on. That looks like sound being broken when it is really two unrelated paths.

## Notes

- The data source is a runtime setting, not an environment variable, and it defaults to **hardware**. In hardware mode the API serves the newest hardware reading only while it is within a 30 second window; after that the dashboard reads "No data". A dashboard stuck on "No data" usually means the board has stopped reporting, not that the app is failing to refresh.
- `SAMPLE_INTERVAL_MS` throttles writes, not the dashboard: the live view polls every second regardless. It defaults to 15s because a transformer's thermal behavior moves over minutes.
- Migrations are embedded into the binary at compile time by `sqlx::migrate!`, so `build.rs` tells cargo to rebuild whenever `migrations/` changes. Without it, adding a migration and starting the dev server looks completely healthy and silently skips it.
- Connections are capped at two per serverless instance and released after ten seconds idle. The session pooler allows fifteen clients in total, and an instance stays warm long after it stops serving: without a timeout, a handful of idle instances hold the entire budget and every cold start after that fails to build, returning 500 on every route including ones that never touch the database.
- The database must be reached through a **session** pooler. sqlx names prepared statements per connection, so a transaction pooler multiplexes them onto shared backends and fails with `42P05 ... already exists` on about half of all requests.
- After changing an environment variable on Vercel, deploy with `--force`. A cached build keeps the old environment.
- Hardware ingest requires the `x-device-key` header to match the API's `DEVICE_API_KEY`; with no key set, ingest is rejected.
- The grid here runs at **60 Hz**; the nominal supply is 230 V.
- Times are stamped in UTC and rendered at UTC+8.

## Scripts

From `app/`:

- `pnpm expo start` starts the development server
- `eas build -p android --profile preview` builds an installable APK
- `node scripts/build-alert-sounds.mjs` regenerates the thirty alert tones

From `api/`:

- `cargo run` starts the API and applies migrations
- `cargo run --bin seed` creates accounts, if you have added a seeder
- `cargo test` runs the unit and property tests

## License

Apache License 2.0. See [LICENSE](LICENSE).
</content>
