import { afterEach, describe, expect, it } from "vitest";
import { assertConfig } from "@/lib/config";

const original = process.env.BETTER_AUTH_SECRET;

afterEach(() => {
  if (original === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = original;
});

describe("assertConfig", () => {
  it("throws a clear error when BETTER_AUTH_SECRET is missing", () => {
    expect(() => assertConfig({})).toThrow(/BETTER_AUTH_SECRET is required/);
    expect(() => assertConfig({ BETTER_AUTH_SECRET: "" })).toThrow(/openssl rand -hex 32/);
  });

  it("passes when BETTER_AUTH_SECRET is set", () => {
    process.env.BETTER_AUTH_SECRET = "env-secret";
    expect(() => assertConfig()).not.toThrow();
    expect(() => assertConfig({ BETTER_AUTH_SECRET: "explicit" })).not.toThrow();
  });
});
