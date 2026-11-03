# Yasha for Android

Gemini-style assistant app talking to a self-hosted [Yasha](../README.md) backend.
Architecture: [docs/architecture.md](../docs/architecture.md). Package `com.yasha.assist`,
`minSdk 30`, Compose + Material 3, dark-first theme (`core:design`).

Modules:

| Module | Role |
| --- | --- |
| `app` | shell, navigation, DI wiring |
| `core:design` | theme/tokens |
| `core:net` | OkHttp client, better-auth session cookie, SSE `/api/chat`, model list |
| `core:capture` | screen capture abstraction (assist snapshot / accessibility / MediaProjection) |
| `feature:chat` | chat UI (M1) |
| `feature:assist` | overlay, corner-swipe surface, circle-to-ask (M2–M4) |

## Build (Docker only — no host SDK)

```sh
cd android
docker compose run --rm gradle assembleDebug      # first run builds the image (SDK image ~2GB)
# APK: app/build/outputs/apk/debug/app-debug.apk
```

Other useful targets: `docker compose run --rm gradle test` (unit tests),
`docker compose run --rm gradle :app:assembleRelease`, `docker compose run --rm gradle lint`.
The Gradle cache persists in the `gradle-home` volume.

## Install on a device

```sh
adb devices                     # wireless adb must be enabled on the phone
adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk
```

## Signing

Debug builds use the auto-generated debug keystore (`~/.android/debug.keystore` inside
the gradle container volume — regenerated if the volume is pruned; fine for QA).
Release builds (F-Droid/sideload):

```sh
keytool -genkeypair -v -keystore yasha-release.keystore -alias yasha \
  -keyalg RSA -keysize 2048 -validity 10000
```

Keep the keystore + passwords **outside the repo**; provide via env
(`YASHA_KEYSTORE`, `YASHA_KEYSTORE_PASSWORD`, `YASHA_KEY_ALIAS`, `YASHA_KEY_PASSWORD`)
and wire them into a `signingConfig` in `app/build.gradle.kts` when M7 packaging starts.

## Versioning (issue #34)

`app/build.gradle.kts` carries the version stamp. On **every app-visible release** bump
`versionCode` (monotonic integer) and set `versionName` to the release git tag
(`v0.2.9` → `"0.2.9"`) — the app compares `versionCode` against the server's
`GET /api/app/version`, which reads the stamp from the APK source tree (Docker `VERSION`
file, gradle-file fallback in dev). `versionName` follows **git tags**, not `package.json`.

## In-app updates (issue #34, Phases B + C)

With a newer stamp on the server, the app offers a self-update: `POST /api/app-update`
ensures the server's **generic** per-version APK (no baked credentials — the installed app
keeps its own session through the package update), the download is sha256-verified, and a
single `PackageInstaller` commit asks the user once (`UpdateController` in `feature:chat`
holds the whole state machine behind two seams; JVM-tested). The dialog shows the
`CHANGELOG.md` section for the offered version. Release signing for server builds: §Signing
above — an unsigned (debug) server build cannot update a release-signed install (§error
"conflict" copy explains the uninstall-once path).

Phase C adds the background half: `UpdateCheckWorker` (WorkManager, 6 h + on app start)
posts an "update available" notification, and with **Settings → App updates → Auto-download
over Wi-Fi** it also builds/downloads/verifies on unmetered networks (`AutoUpdate.kt`,
JVM-tested), leaving a verified APK + `UpdateMeta` marker in the cache and a "ready to
install" reminder — the install tap always happens in the foreground app. Everything is
gated by the admin toggle `app_updates.enabled` (web Settings → General): when off, the
endpoints 403/409, banners drop and notifications are cancelled.

## Assistant role (M2)

Granting the default-assistant role works through the **system default-app picker**
(in-app **Settings → Choose Yasha in default-app settings** opens it directly, falling
back to the generic default-apps screen): **Settings → Apps → Default apps → Digital
assistant app → Yasha** (+ confirmation dialog). Notes:

- **Do not use `RoleManager.createRequestRoleIntent(ROLE_ASSISTANT)`**: since
  Android 14-QPR the role is `requestable="false"` in the permission controller's
  `roles.xml`, so the request dialog is refused **for every app** (Home Assistant
  included) with `RequestRoleActivity: Role is not requestable`. The picker uses the
  privileged holder path and works fine. Deep link:
  `Intent("android.intent.action.MANAGE_DEFAULT_APP")` +
  `android.intent.extra.ROLE_NAME = android.app.role.ASSISTANT`
  (handled by `com.android.permissioncontroller/.role.ui.DefaultAppActivity`).
- Picker qualification (`AssistantRoleBehavior.isAssistantVoiceInteractionService`)
  requires a `VoiceInteractionService` (permission `BIND_VOICE_INTERACTION`, intent-filter
  `android.service.voice.VoiceInteractionService`) whose `android.voice_interaction`
  metadata has **`sessionService` AND `recognitionService` AND `supportsAssist="true"`** —
  missing `recognitionService` makes the app invisible in the picker. `YashaRecognitionService`
  is a deliberate no-op (STT out of scope; Android 15 also refuses VIMS binding without it).
- Only one default assistant at a time — granting Yasha replaces the current one.
  Reinstalling with a **different signature** resets the role; debug reinstalls
  (same keystore, persisted in the `gradle-android-home` volume) keep it.
- `YashaSession.onShow` must **not** call `finish()` synchronously (invalid window
  token → `BadTokenException`); it posts the finish to the main looper (Home Assistant pattern).
- Without the role the fallbacks work: quick-settings tile **Ask Yasha**,
  long-press launcher icon → **Ask Yasha** shortcut, and the **Ask Yasha** notification
  action (needs POST_NOTIFICATIONS on Android 13+; self-cancels once the role is held).
- Verify state with: `adb shell cmd role get-role-holders android.app.role.ASSISTANT`,
  `adb shell settings get secure assistant`, `adb shell dumpsys voiceinteraction | grep mComponent`,
  and trigger with `adb shell input keyevent KEYCODE_ASSIST`.

## Screen capture & circle-to-ask (M3)

Triggers (assistant role, tile, shortcut, notification) open the **floaty**: a transparent
overlay showing a frozen screenshot of the screen behind it + a pill composer.

- Capture sources, in order: assist-session `onHandleScreenshot` (role-triggered; needs the
  screen-content permission dialog once) → `AccessibilityService.takeScreenshot()`
  (**enable Settings → Accessibility → Yasha**, screenshot-only capability) → clear
  "no source / content protected" states (secure windows are never captured).
- **Circle to ask**: toggle in the composer, draw a loop around anything → bounding box with
  8 draggable handles; the crop (≤1568 px JPEG, same caps as the web client) is attached to
  the question.
- The answer streams **in the overlay**; swipe the handle up (or **Open in Yasha**) to
  continue the same thread full-screen; **New question** keeps the crop for a follow-up.
- If Yasha is not yet the default assistant, the same floaty is reachable from the QS tile /
  shortcut / notification (assist screenshot unavailable → a11y capture).

## Auth against the backend (decision D-2)

Primary: **better-auth session cookie** (email/password), identical to the web client.
The Android client stores the `better-auth.session_token` cookie + CSRF token in
`EncryptedSharedPreferences` and replays them on every call.

- `POST <base>/api/auth/sign-in/email` — `{"email","password"}` → `Set-Cookie: better-auth.session_token`
- `GET  <base>/api/auth/get-session` — session probe (tri-state, issue #14: only a
  server-confirmed sign-out clears the stored token; a transport failure keeps the
  session and shows the offline banner with auto-retry instead of the login form)
- `POST <base>/api/auth/sign-out` — revoke

Alternative (power users): an API key, `Authorization: Bearer <key>` against
`/v1/chat/completions`. Create one in the web UI: **Settings → API keys → New key**
(shown once, `ya_…` prefix). The app uses session-cookie mode against `/api/chat`
(server-side memory/threading); the raw `/v1` route is stateless.

The server must be reachable from the phone (LAN/VPN). Cleartext HTTP is blocked by
default — serve Yasha over TLS (the compose stack puts Caddy in front), or use a
`tshark`-free `adb reverse tcp:3000 tcp:3000` for local dev against plain HTTP.
