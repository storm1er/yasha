// App version stamp reader + public endpoint (issue #34, Phase A).

import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as appVersionRoute from "@/app/api/app/version/route";
import { parseGradleVersion, parseVersionFile, readAppVersion } from "@/lib/app-version";
import { callRoute } from "./support/app";

let seq = 0;

/** Fake clock/filesystem: deterministic, no real IO for the lib tests. */
function fakeFs(files: Record<string, { text: string; mtimeMs: number }>) {
  let stats = 0;
  let reads = 0;
  return {
    fs: {
      stat: async (path: string) => {
        stats++;
        const f = files[path];
        if (!f) throw new Error("ENOENT");
        return { mtimeMs: f.mtimeMs };
      },
      readFile: async (path: string) => {
        reads++;
        const f = files[path];
        if (!f) throw new Error("ENOENT");
        return f.text;
      },
    },
    counters: () => ({ stats, reads }),
    touch: (path: string, mtimeMs: number) => {
      files[path].mtimeMs = mtimeMs;
    },
    write: (path: string, text: string) => {
      files[path].text = text;
    },
  };
}

describe("app-version parsers", () => {
  it("VERSION file: code<TAB>name; malformed rejects", () => {
    expect(parseVersionFile("3\t0.3.0")).toEqual({ versionCode: 3, versionName: "0.3.0" });
    expect(parseVersionFile(" 3\t0.3.0 \n")).toEqual({ versionCode: 3, versionName: "0.3.0" });
    expect(parseVersionFile("nope")).toBeNull();
  });

  it("build.gradle.kts: versionCode/versionName regex; partial rejects", () => {
    expect(
      parseGradleVersion('compileSdk = 35\n    versionCode = 12\n    versionName = "0.2.9"\n'),
    ).toEqual({ versionCode: 12, versionName: "0.2.9" });
    expect(parseGradleVersion('versionName = "0.2.9"')).toBeNull(); // no code
    expect(parseGradleVersion("versionCode = 7")).toBeNull(); // no name
  });
});

describe("readAppVersion", () => {
  it("prefers the VERSION file over the gradle fallback", async () => {
    const dir = `/av-${seq++}`;
    const h = fakeFs({
      [join(dir, "VERSION")]: { text: "9\t9.9.9", mtimeMs: 1 },
      [join(dir, "app", "build.gradle.kts")]: { text: 'versionCode = 1\nversionName = "x"', mtimeMs: 1 },
    });
    expect(await readAppVersion(dir, h.fs)).toEqual({ versionCode: 9, versionName: "9.9.9" });
  });

  it("falls back to the gradle parse when VERSION is missing", async () => {
    const dir = `/av-${seq++}`;
    const h = fakeFs({
      [join(dir, "app", "build.gradle.kts")]: { text: 'versionCode = 4\nversionName = "0.4.0"', mtimeMs: 1 },
    });
    expect(await readAppVersion(dir, h.fs)).toEqual({ versionCode: 4, versionName: "0.4.0" });
  });

  it("unparsable or absent sources → null", async () => {
    const dir = `/av-${seq++}`;
    const h = fakeFs({
      [join(dir, "VERSION")]: { text: "garbage", mtimeMs: 1 },
      [join(dir, "app", "build.gradle.kts")]: { text: "no stamps here", mtimeMs: 1 },
    });
    expect(await readAppVersion(dir, h.fs)).toBeNull();
    expect(await readAppVersion(`/av-nope-${seq++}`, fakeFs({}).fs)).toBeNull();
  });

  it("caches for the process lifetime and re-reads when the mtime moves", async () => {
    const dir = `/av-${seq++}`;
    const versionFile = join(dir, "VERSION");
    const h = fakeFs({ [versionFile]: { text: "1\t0.1.0", mtimeMs: 100 } });
    expect(await readAppVersion(dir, h.fs)).toEqual({ versionCode: 1, versionName: "0.1.0" });
    expect(await readAppVersion(dir, h.fs)).toEqual({ versionCode: 1, versionName: "0.1.0" });
    expect(h.counters().reads).toBe(1); // second call: cache hit

    h.write(versionFile, "2\t0.2.0");
    h.touch(versionFile, 200);
    expect(await readAppVersion(dir, h.fs)).toEqual({ versionCode: 2, versionName: "0.2.0" });
    expect(h.counters().reads).toBe(2); // mtime moved → re-read
  });

  it("a file that stats but fails to read is skipped (racy rm -rf)", async () => {
    const dir = `/av-${seq++}`;
    const racy = {
      stat: async (path: string) => {
        if (path !== join(dir, "VERSION")) throw new Error("ENOENT");
        return { mtimeMs: 5 };
      },
      readFile: async () => {
        throw new Error("EACCES");
      },
    };
    expect(await readAppVersion(dir, racy)).toBeNull();
  });
});

describe("GET /api/app/version", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yasha-appver-"));
  });

  it("serves the VERSION file of YASHA_APK_SOURCE_DIR", async () => {
    const dir = join(root, `v${seq++}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "VERSION"), "7\t0.7.7");
    vi.stubEnv("YASHA_APK_SOURCE_DIR", dir);
    const res = await callRoute(appVersionRoute.GET, { path: "/api/app/version" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ versionCode: 7, versionName: "0.7.7" });
    vi.unstubAllEnvs();
  });

  it("dev tree without VERSION: parses app/build.gradle.kts", async () => {
    const dir = join(root, `g${seq++}`);
    await mkdir(join(dir, "app"), { recursive: true });
    await writeFile(join(dir, "app", "build.gradle.kts"), '    versionCode = 5\n    versionName = "0.5.0"\n');
    vi.stubEnv("YASHA_APK_SOURCE_DIR", dir);
    const res = await callRoute(appVersionRoute.GET, { path: "/api/app/version" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ versionCode: 5, versionName: "0.5.0" });
    vi.unstubAllEnvs();
  });

  it("unreadable source → 503 version_unavailable", async () => {
    vi.stubEnv("YASHA_APK_SOURCE_DIR", join(root, "does-not-exist"));
    const res = await callRoute(appVersionRoute.GET, { path: "/api/app/version" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("version_unavailable");
    vi.unstubAllEnvs();
  });

  it("unset YASHA_APK_SOURCE_DIR: falls back to the shipped /opt path", async () => {
    vi.stubEnv("YASHA_APK_SOURCE_DIR", undefined);
    // Test/dev containers have no /opt/yasha-android → same 503 arm.
    const res = await callRoute(appVersionRoute.GET, { path: "/api/app/version" });
    expect(res.status).toBe(503);
    vi.unstubAllEnvs();
  });

  // LAST: exhausts the shared auth bucket for this route key.
  it("auth-grade rate limit on the unauthenticated endpoint", async () => {
    vi.stubEnv("YASHA_APK_SOURCE_DIR", undefined);
    process.env.YASHA_RATE_LIMIT = "";
    process.env.RATE_LIMIT_AUTH_PER_MIN = "2";
    try {
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        codes.push((await callRoute(appVersionRoute.GET, { path: "/api/app/version" })).status);
      }
      expect(codes).toEqual([503, 503, 429]);
    } finally {
      process.env.YASHA_RATE_LIMIT = "off";
      delete process.env.RATE_LIMIT_AUTH_PER_MIN;
      vi.unstubAllEnvs();
    }
  });
});
