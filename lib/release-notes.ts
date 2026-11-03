// Release notes for the in-app update dialog (issue #34, Phase C).
//
// CI regenerates CHANGELOG.md (Keep a Changelog / git-cliff, headings like
// `## [0.2.12] - 2026-11-03`) on every release, so the excerpt for the update
// being offered is simply the section whose heading matches the version stamp
// the server would build. Location: `<apk source dir>/CHANGELOG.md` (runtime
// image copies it next to the APK tree), falling back to the parent directory
// (dev tree: /app/android + /app/CHANGELOG.md).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_NOTES = 1500;

/** Section body for `## [v]<versionName>` up to the next `##` heading (capped). */
export function parseReleaseNotes(src: string, versionName: string): string | null {
  const escaped = versionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^##\\s+\\[?v?${escaped}(?:\\]|\\b)`);
  const lines = src.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (start < 0) {
      if (heading.test(line)) start = i + 1;
    } else if (/^##\s/.test(line)) {
      return cap(lines.slice(start, i).join("\n"));
    }
  }
  return start < 0 ? null : cap(lines.slice(start).join("\n"));
}

function cap(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_NOTES ? `${trimmed.slice(0, MAX_NOTES).trimEnd()}…` : trimmed;
}

/** Candidate paths, first hit wins (runtime layout, then the dev-tree layout). */
export function changelogCandidates(sourceDir: string): string[] {
  const override = process.env.YASHA_CHANGELOG_PATH;
  if (override) return [override];
  return [join(sourceDir, "CHANGELOG.md"), join(dirname(sourceDir), "CHANGELOG.md")];
}

/** Notes for `versionName`, or null (no file / no matching section / empty). */
export async function readReleaseNotes(sourceDir: string, versionName: string): Promise<string | null> {
  for (const path of changelogCandidates(sourceDir)) {
    if (!existsSync(path)) continue;
    try {
      return parseReleaseNotes(await readFile(path, "utf8"), versionName);
    } catch {
      return null;
    }
  }
  return null;
}
