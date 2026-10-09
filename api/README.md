# VITAL API (Go)

The API the ESP32 and the app talk to: net/http, libSQL over HTTP against Turso, HS256
JWTs and argon2id password hashes. It replaced the earlier Rust (Axum) build with the same
routes, status codes, JSON bodies, tokens, database and environment variables, so neither
the board nor the app noticed the switch.

## Layout

```
api/index.go            Vercel entrypoint (package handler, func Handler): a wrapper around vercel.Handler.
vercel/                 Builds the app once per instance and serves it. Separate from api/ because the
                        runtime renames the module to "handler", so api/index.go may not import internal/.
cmd/server              Local dev server on PORT.
cmd/migrate             Applies schema.sql (or -file <migration>) to DATABASE_URL.
schema.go, schema.sql   The schema, embedded for cmd/migrate.
migrations/             One-off migrations for an existing database (not idempotent).
internal/
  app        Wires everything: Deps (shared stores), Routes (the mux + middleware), health.
  config     Env vars (names, defaults and validation) and a .env loader.
  db         Opens libSQL over HTTP; IsUniqueViolation, EscapeLike, ApplySchema, Now.
  httpx      Errors -> responses (one place), JSON in/out, query/path parsing, paging,
             CORS, logging/recover, per-IP rate limiting.
  wire       JSON encodings matching serde: wire.Float, wire.Time, LocalLabel, ParseTime.
  auth       Role, HS256 JWT, argon2id PHC hashes, Guard middleware (User/Admin/Device).
  account    /auth/* handlers (login, register, me, password). Separate from auth to
             avoid an auth <-> users import cycle.
  users      /users/* handlers and the users Store (also used by account).
  settings   /settings/* handlers and the settings Store (thresholds for readings/device).
```

## Running locally

```sh
cd api
go run ./cmd/server            # loads ./.env; listens on PORT (8080)
PORT=8091 go run ./cmd/server  # variables already set win over the .env file
```

Against a throwaway local database instead of Turso (dev/test only, pure-Go SQLite,
compiled in only with the `sqlite` tag):

```sh
DATABASE_URL=file:/tmp/vital-dev.db go run -tags sqlite ./cmd/migrate
DATABASE_URL=file:/tmp/vital-dev.db go run -tags sqlite ./cmd/server
```

Checks:

```sh
go build ./... && go vet ./... && go test ./...
go test -tags sqlite ./...      # adds end-to-end tests (internal/app) on a temp SQLite file
gofmt -l .
```

`cmd/migrate` reads `.env` like the server, so without an explicit `DATABASE_URL` it
targets the live database. `-file migrations/<name>.sql` applies one migration; those are
not idempotent, so each runs once. `0023_account_approval.sql` (adds `users.status`) was
applied to the live database on 2026-10-09.

## Environment

Identical to the Rust API: `DATABASE_URL` (libsql:// or https://, normalized to
https://; `file:` only with `-tags sqlite`), `DATABASE_AUTH_TOKEN`, `JWT_SECRET`
(required, set-but-empty accepted), `PORT` (8080), `SIMULATOR_ENABLED` (`true`/`false`
only, default true), `SAMPLE_INTERVAL_MS` (15000), `DEVICE_API_KEY` (trimmed; blank =
unset = every device request rejected).

## Deploying (Vercel)

`vercel.json` mirrors the Rust one: region `hnd1`, rewrite `/api/v1/:path*` →
`/api/index`. The request keeps its original path, so the router matches
`/api/v1/...`. Health is `GET /api/v1/health` (the Rust router has no root `/health`
either). `go.mod` says `go 1.26.0` (no `toolchain` line); `@vercel/go` maps it to
Go 1.26.x. The builder rewrites go.mod to `module handler` (with a `replace` back to
this directory) before building `api/index.go`, so that file must only import
non-internal packages; keep it a thin wrapper around `vercel.Handler`.

## Adding a route group (phase 2/3)

1. Create `internal/<group>/` with a `Store` (SQL, takes `*sql.DB`) and a `Handler`
   with `Register(mux *http.ServeMux)`, like `internal/settings/settings.go`.
2. Register patterns as `"METHOD " + httpx.APIPrefix + "/<group>/..."`. Wrap each
   handler with its access rule; the guard runs before path/body parsing, which is the
   order axum ran the Rust extractors in:
   - any signed-in caller: `guard.User(httpx.HandlerFunc(h.fn))` (Rust `AuthUser`)
   - admin: `guard.Admin(...)` (Rust `AdminUser`; 401 then 403)
   - ESP32: `guard.Device(...)` (Rust `DeviceAuth`; constant-time `x-device-key`)
   - public: `httpx.HandlerFunc(h.fn)`
3. Write handlers as `func(w http.ResponseWriter, r *http.Request) error` and return
   errors; `httpx.WriteError` turns them into responses in one place:
   - `httpx.BadRequest("lowercase message %s", x)` → 400 `{"error":"Lowercase message …"}`
     (sentence-cased on output, exactly like `AppError::BadRequest`)
   - `httpx.ErrNotFound`, `ErrUnauthorized`, `ErrForbidden`, `ErrInvalidCredentials`,
     `httpx.Upstream(...)` (502), `httpx.ErrToken.With(err)` / `ErrPasswordHash.With(err)`
   - any other error → 500 `{"error":"Database error"}`, except a SQLite unique
     violation anywhere in the chain → 409 `{"error":"Already exists"}`. Wrap with `%w`.
4. Inputs:
   - body: `httpx.DecodeJSON(r, &in)`; tag required fields `required:"true"`, make
     `Option<T>` fields pointers. Gives axum's 415/413/400/422 plain-text rejections.
   - query: `q := httpx.NewQuery(r)`; `q.String/Int64/Float64/Bool/RequiredString`;
     then `if err := q.Err(); err != nil { return err }`. `httpx.Filter` trims and treats
     blank as absent.
   - path: `httpx.PathUUID(r, "id")`, `httpx.PathInt64(r, "id")`.
   - caller: `id, _ := auth.IdentityFrom(r.Context())` (`id.ID`, `id.Role`).
   - paging: `limit, offset := httpx.ResolvePaging(q.Int64("limit"), q.Int64("offset"), def, max)`
     and respond `httpx.NewPage(rows, total, limit, offset)` → `{rows,total,limit,offset}`.
   - search: `db.EscapeLike(needle)` with `like '%' || ?N || '%' escape '\'` in SQL.
5. Outputs: `httpx.WriteJSON(w, status, v)`; `httpx.NoContent(w, 201|204)`. Use
   `wire.Float` (`*wire.Float` when nullable) for every f64 and `wire.Time` for every
   timestamp so bodies match serde byte for byte (`900.0`, not `900`). Keep struct field
   order equal to the Rust struct's; no `omitempty` (serde writes `null`).
6. SQL conventions: `?1..?N` placeholders; ids `uuid.NewString()`; "now" is `db.Now`
   in SQL; when binding a time from Go use `wire.FormatStorage(t)` — never bind a
   `time.Time` (the libSQL driver would store `2006-01-02 15:04:05…`); read timestamps
   with `wire.ParseTime`. Booleans are 0/1 integers.
7. Shared state goes through `app.Deps` (`Config`, `DB`, `Guard`, `Users`, `Settings`);
   construct and `Register` your handler in `app.Routes`. Config already carries
   `SimulatorEnabled`, `SampleIntervalMS` and `DeviceAPIKey`.
8. Tests: unit tests next to the code; end-to-end ones in a `//go:build sqlite` file
   (see `internal/app/app_sqlite_test.go` for the harness: temp DB from `api.Schema`,
   seeded admin, `httptest.Server`).

## CONTRACT (ported so far)

All paths under `/api/v1`. Errors are `{"error":"<Sentence-cased message>"}`;
request-shape rejections are plain text (415 wrong Content-Type, 413 >2 MiB, 400 bad
JSON / bad query / bad path id, 422 JSON of the wrong shape). CORS: any origin; any
`OPTIONS` → 200 with `Access-Control-Allow-{Origin,Methods,Headers}: *`. Unrouted
paths 404 and wrong methods 405 (with `Allow`) with empty bodies.

Shapes used below:

- **Profile** `{id, email|null, username, role:"admin"|"user", firstName, middleName|null, lastName, fullName}`
- **User** `{id, email|null, username, role, firstName, middleName|null, lastName, fullName, status:"pending"|"active", createdAt}`
- **Settings** `{loadThresholdVa, tripThresholdVa, tempThresholdC, recloseDelaySeconds, tripConfirmSeconds, sourceMode, updatedAt}`
- timestamps: RFC 3339 UTC with `Z` and 0/3/6/9 fraction digits; floats always carry a fraction (`900.0`).

| Method | Path | Auth | Request | Success | Errors |
|---|---|---|---|---|---|
| GET | `/health` | public | – | 200 `{status:"ok", checkedAt, checkedAtLabel}` (label is PH time, e.g. `October 9, 2026 10:54 AM`) | – |
| POST | `/auth/login` | public, 10 burst then 1/10 s per IP | `{identifier` (alias `email`)`, password, role?:"admin"\|"user"}` | 200 `{token, user: Profile}` | 401 Invalid credentials; 403 Your account is waiting for an admin to approve it (only after a correct password); 401 portal hint (`You're an admin. Choose Admin above, then sign in`); 429 Too many attempts, try again in Ns |
| POST | `/auth/register` | public, 3 burst then 1/60 s per IP | `{firstName, middleName?, lastName, username?, email?, password}` | 201 `{username}` (account is `pending`, role `user`) | 400 First name is required / Last name is required / Password must be at least 8 characters / Invalid email / Email already registered / Username already taken; 409 Already exists; 429 |
| GET | `/auth/me` | user | – | 200 Profile | 401; 404 |
| PUT | `/auth/me` | user | `{firstName, middleName?, lastName, email?, username?}` | 200 Profile | 400 First name is required / Last name is required / Invalid email / Username is required; 403 Admin access required (non-admin changing email/username); 409 |
| PUT | `/auth/password` | user | `{currentPassword, newPassword}` | 204 | 400 New password must be at least 8 characters; 401 Invalid credentials |
| GET | `/users` | admin | query `q?`, `role?` (admin\|user), `status?` (pending\|active) | 200 `[User]` (array, oldest first) | 400 Invalid role: x / Invalid status: x |
| POST | `/users` | admin | `{email?, password, role, firstName, middleName?, lastName, username?}` | 201, empty body (status `active`) | 400 Password must be at least 8 characters / Invalid email / First name is required / Last name is required / Email already registered / Username already taken; 409 |
| GET | `/users/username-suggestion` | admin | query `firstName`, `lastName` (both required) | 200 `{username}` | 400 (plain text, missing field) |
| PUT | `/users/{id}` | admin | `{email?, role, firstName, middleName?, lastName, username?, password?}` (blank email clears; blank username/password keeps) | 200 User | 400 Invalid email / First name… / Last name… / Password must be at least 8 characters / You cannot change your own role; 404; 409 |
| DELETE | `/users/{id}` | admin | – | 204 | 400 You cannot delete your own account / An admin cannot be deleted. Change the role to user first; 404 |
| POST | `/users/{id}/approve` | admin | – | 200 User (idempotent) | 404 |
| GET | `/settings` | user | – | 200 Settings | 502 Upstream error: the settings row is missing |
| PUT | `/settings` | admin | `{loadThresholdVa, tripThresholdVa, tempThresholdC, recloseDelaySeconds, tripConfirmSeconds?}` (absent trip delay is kept) | 200 Settings | 400 Load threshold must be greater than zero / Temperature threshold must be greater than zero / Trip threshold must be greater than the alarm threshold / Reclose delay must be between 5 and 600 seconds / Trip delay must be between 1 and 60 seconds |
| PUT | `/settings/source` | admin | `{sourceMode:"simulation"\|"hardware"}` | 200 Settings | 400 Source mode must be simulation or hardware |

Auth failures everywhere: 401 `Missing or invalid token` (no/invalid/expired bearer),
403 `Admin access required` (admin routes). Tokens: HS256 `{"typ":"JWT","alg":"HS256"}`,
claims `{sub: uuid, role, exp}`, 12 h, 60 s leeway, signed with `JWT_SECRET`;
interchangeable with Rust-issued tokens. Passwords: argon2id PHC
(`m=19456,t=2,p=1`), interchangeable with the Rust hashes.

## Known differences from the Rust build

- Plain-text rejection bodies keep the same status and prefix but not serde's detail
  (no "at line 1 column 14", type names differ).
- encoding/json matches object keys case-insensitively for optional fields (serde is
  exact); required fields are checked exactly.
- A panicking handler answers 500 `{"error":"Internal server error"}` instead of
  dropping the connection.
