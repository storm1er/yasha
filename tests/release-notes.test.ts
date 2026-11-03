// lib/release-notes: CHANGELOG section extraction for the update dialog
// (issue #34, Phase C).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changelogCandidates, parseReleaseNotes, readReleaseNotes } from "@/lib/release-notes";

const SRC = [
  "# Changelog",
  "",
  "Preamble text.",
  "",
  "## [0.2.12] - 2026-11-03",
  "",
  "### Features",
  "- **app-update:** shiny thing (abc1234)",
  "",
  "### Bug Fixes",
  "- fixed another (def4567)",
  "",
  "## [0.2.11] - 2026-11-02",
  "",
  "- older section",
  "",
].join("\n");

describe("parseReleaseNotes", () => {
  it("extracts the matching section up to the next heading", () => {
    const notes = parseReleaseNotes(SRC, "0.2.12");
    expect(notes).toContain("shiny thing");
    expect(notes).toContain("fixed another");
    expect(notes).not.toContain("older section");
    expect(notes).not.toContain("Preamble");
  });

  it("accepts git-cliff `## v1.2.3` and bare `## 1.2.3` headings", () => {
    expect(parseReleaseNotes("## v1.2.3\n\nhello\n", "1.2.3")).toBe("hello");
    expect(parseReleaseNotes("## 1.2.3 — 2026\n\nhello\n", "1.2.3")).toBe("hello");
  });

  it("section runs to EOF when no further heading follows", () => {
    expect(parseReleaseNotes("## [9.9.9]\n\nfirst\n\nstill one\n", "9.9.9")).toBe("first\n\nstill one");
    // Any `## ` line closes the section, malformed heading included.
    expect(parseReleaseNotes("## [9.9.9]\n\nfirst\n\n## nope\n", "9.9.9")).toBe("first");
  });

  it("no match / empty section → null; dots stay literal", () => {
    expect(parseReleaseNotes(SRC, "1.0.0")).toBeNull();
    expect(parseReleaseNotes("## [0.2.12]\n\n   \n## [0.2.11]\n", "0.2.12")).toBeNull();
    expect(parseReleaseNotes("## [020x120z3]\n- trap\n", "0.2.12")).toBeNull();
  });

  it("long sections are capped with an ellipsis", () => {
    const notes = parseReleaseNotes(`## [1.0.0]\n${"x".repeat(2000)}\n`, "1.0.0");
    expect(notes!.length).toBeLessThanOrEqual(1501); // cap + …
    expect(notes!.endsWith("…")).toBe(true);
  });
});

describe("readReleaseNotes / path resolution", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yasha-notes-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.YASHA_CHANGELOG_PATH;
  });

  it("prefers <sourceDir>/CHANGELOG.md (runtime layout)", async () => {
    writeFileSync(join(dir, "CHANGELOG.md"), "## [1.1.1]\n- next to the tree\n");
    expect(await readReleaseNotes(dir, "1.1.1")).toBe("- next to the tree");
  });

  it("falls back to the parent dir (dev tree: /app/android ← /app/CHANGELOG.md)", async () => {
    const src = join(dir, "android");
    writeFileSync(join(dir, "CHANGELOG.md"), "## [2.2.2]\n- repo root\n");
    expect(await readReleaseNotes(src, "2.2.2")).toBe("- repo root");
  });

  it("no file anywhere → null", async () => {
    expect(await readReleaseNotes(join(dir, "nothing"), "1.0.0")).toBeNull();
  });

  it("YASHA_CHANGELOG_PATH overrides the resolution order", async () => {
    writeFileSync(join(dir, "CHANGELOG.md"), "## [3.3.3]\n- ignored\n");
    const custom = join(dir, "custom.md");
    writeFileSync(custom, "## [3.3.3]\n- override wins\n");
    process.env.YASHA_CHANGELOG_PATH = custom;
    expect(changelogCandidates(dir)).toEqual([custom]);
    expect(await readReleaseNotes(dir, "3.3.3")).toBe("- override wins");
  });

  it("unreadable file (directory where the changelog would be) → null", async () => {
    // A directory named CHANGELOG.md stats but readFile throws EISDIR.
    const src = join(dir, "src");
    mkdirSync(join(src, "CHANGELOG.md"), { recursive: true });
    expect(await readReleaseNotes(src, "1.0.0")).toBeNull();
  });
});
