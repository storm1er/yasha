import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { relativeTime } from "@/lib/relative-time";
import { msToSeconds, secondsToMs } from "@/lib/ms-seconds";

const NOW = Date.parse("2026-03-15T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("relativeTime", () => {
  it("uses second bucket strictly below a minute", () => {
    expect(relativeTime(iso(-30_000), "en")).toBe("30 seconds ago");
    expect(relativeTime(iso(30_000), "en")).toBe("in 30 seconds");
    expect(relativeTime(iso(0), "en")).toBe("now");
  });

  it("uses minute bucket strictly below an hour", () => {
    expect(relativeTime(iso(-MIN), "en")).toBe("1 minute ago");
    expect(relativeTime(iso(HOUR - 1), "en")).toBe("in 60 minutes");
  });

  it("uses hour bucket strictly below a day", () => {
    expect(relativeTime(iso(-HOUR), "en")).toBe("1 hour ago");
    expect(relativeTime(iso(DAY - 1), "en")).toBe("in 24 hours");
  });

  it("uses day bucket strictly below 30 days", () => {
    expect(relativeTime(iso(-DAY), "en")).toBe("yesterday");
    expect(relativeTime(iso(29 * DAY), "en")).toBe("in 29 days");
  });

  it("falls back to an absolute date at 30 days and beyond", () => {
    expect(relativeTime(iso(30 * DAY), "en")).toBe(
      new Intl.DateTimeFormat("en").format(new Date(iso(30 * DAY)))
    );
    expect(relativeTime(iso(-400 * DAY), "en")).toBe(
      new Intl.DateTimeFormat("en").format(new Date(iso(-400 * DAY)))
    );
  });

  it("honours non-English locales", () => {
    expect(relativeTime(iso(-MIN), "fr")).toBe("il y a 1 minute");
  });
});

describe("msToSeconds", () => {
  it("renders blank for non-positive or non-finite input", () => {
    expect(msToSeconds(0)).toBe("");
    expect(msToSeconds(-5)).toBe("");
    expect(msToSeconds(Number.NaN)).toBe("");
    expect(msToSeconds(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("renders whole and fractional seconds", () => {
    expect(msToSeconds(5000)).toBe("5");
    expect(msToSeconds(1500)).toBe("1.5");
    expect(msToSeconds(1234)).toBe("1.234");
  });
});

describe("secondsToMs", () => {
  it("parses decimals, commas and whitespace", () => {
    expect(secondsToMs(" 2.5 ")).toBe(2500);
    expect(secondsToMs("2,5")).toBe(2500);
  });

  it("rejects non-positive and non-finite input", () => {
    expect(secondsToMs("abc")).toBeNull();
    expect(secondsToMs("0")).toBeNull();
    expect(secondsToMs("-3")).toBeNull();
  });

  it("floors sub-millisecond positives to zero -> null", () => {
    expect(secondsToMs("0.0004")).toBeNull();
  });
});
