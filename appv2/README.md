# Vital web (appv2)

The Vital app as a website, packaged for Android with Capacitor. It is a 1:1 port of
the original Expo app (retired; still in git history), with the same screens, copy,
colours and API.

**Stack:** Vite, React 19, TypeScript, Tailwind 3 (the same tokens as the Expo app),
React Router, Phosphor icons, KaTeX, Capacitor 8.

## Run it

```bash
cp .env.example .env        # point VITE_API_URL at the API
pnpm install
pnpm dev                    # http://localhost:5173
```

`pnpm build` writes the static site to `dist/`. Any static host works; `vercel.json`
rewrites every path to `index.html` so deep links such as `/alerts` load.

## Android

Needs JDK 21 and the Android SDK (`ANDROID_HOME`, or `sdk.dir` in
`android/local.properties`).

```bash
pnpm apk        # build the site, sync it into android/, assemble a debug APK
pnpm android    # same sync, then open the project in Android Studio
```

The APK lands in `android/app/build/outputs/apk/debug/`. `VITE_API_URL` is baked in at
build time, so set it to the deployed API (`https://dynavolt-api.vercel.app/api/v1`)
before building one for a phone.

## How the code is organised

It is an ordinary website: semantic HTML, Tailwind for layout, React Router for pages.
Capacitor only wraps the built site for Android; nothing in `src/` is written for it.

- `src/routes/` holds the pages. `tabs/layout.tsx` is the shell: a fixed sidebar on a
  wide window, bottom tabs on a phone, and one `<main>` every page renders into. The
  document scrolls, like any site.
- `src/components/ui/` holds the shadcn-style building blocks (button, card, badge,
  segmented control, sheet rows, page header). `src/components/settings/` and
  `src/components/ac/` are the pieces specific to one page.
- On a phone, cards inside `<main>` run edge to edge (see `global.css`).
- `src/features/` holds the API clients and types, one folder per domain.
- Storage is Capacitor Preferences (`src/lib/storage.ts`), which is localStorage in a
  browser and SharedPreferences on Android.

## Differences from the Expo app

- **Remote push is off.** The API sends through Expo's push service, which only accepts
  tokens from an Expo app. Bringing it back needs a Firebase project
  (`google-services.json`) and the API sending through FCM. In-app alarms and local
  notifications still work.
- **Reading the board directly** (`/live` on the LAN) works in the Android app and on
  the local dev server. A site served over https cannot call a plain-http address, so
  the deployed website reads through the API instead, which it already falls back to.
