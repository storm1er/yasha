// Android app version stamp (issue #34, Phase A).
//
// The APK source tree is the app's update channel (lib/apk-builder.ts): upgrading the stack is
// what publishes an app update, so the server answers "what version should the app be?" from
// that tree. Preferred source is the `VERSION` file written during the Docker apk-prewarm stage
// (`<versionCode>\t<versionName>` — parsing Kotlin DSL at runtime is brittle); the runtime-parse
// fallback of `app/build.gradle.kts` covers dev mode, where YASHA_APK_SOURCE_DIR points at the
// mounted working tree and no VERSION file exists.
//
// Successful reads cache for the process lifetime, keyed by path, and are re-read when the file
// mtime moves (dev iteration). Everything IO is injected: deterministic under test.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type AppVersion = { versionCode: number; versionName: string };

type Fs = {
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<{ mtimeMs: number }>;
};

const realFs: Fs = {
  readFile: (p) => readFile(p, "utf8"),
  stat: async (p) => await stat(p),
};

const cache = new Map<string, { mtimeMs: number; version: AppVersion }>();

/** `<versionCode>\t<versionName>` (the VERSION file the Dockerfile writes). */
export function parseVersionFile(src: string): AppVersion | null {
  const m = /^(\d+)\t(.+)$/.exec(src.trim());
  if (!m) return null;
  return { versionCode: Number(m[1]), versionName: m[2] };
}

/** Regex over app/build.gradle.kts: `versionCode = <int>` / `versionName = "<x>"`. */
export function parseGradleVersion(src: string): AppVersion | null {
  const code = /versionCode\s*=\s*(\d+)/.exec(src)?.[1];
  const name = /versionName\s*=\s*"([^"]+)"/.exec(src)?.[1];
  if (!code || !name) return null;
  return { versionCode: Number(code), versionName: name };
}

async function fromFile(
  path: string,
  parse: (src: string) => AppVersion | null,
  fs: Fs,
): Promise<AppVersion | null> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(path)).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.version;
  let text: string;
  try {
    text = await fs.readFile(path);
  } catch {
    return null;
  }
  const version = parse(text);
  if (!version) return null;
  cache.set(path, { mtimeMs, version });
  return version;
}

/** Effective stamp from the APK source tree, or null when nothing readable (→ 503). */
export async function readAppVersion(dir: string, fs: Fs = realFs): Promise<AppVersion | null> {
  return (
    (await fromFile(join(dir, "VERSION"), parseVersionFile, fs)) ??
    (await fromFile(join(dir, "app", "build.gradle.kts"), parseGradleVersion, fs))
  );
}
