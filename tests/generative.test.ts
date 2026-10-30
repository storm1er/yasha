// Unit tests for the generative-UI card envelope (issue #16, Milestone 1).

import { describe, expect, it } from "vitest";
import { extractToolCard, parseGenerativeCard, CARD_KIND_DEFAULT } from "@/lib/chat/generative";

describe("parseGenerativeCard", () => {
  it("accepts the minimal card (title only, default kind)", () => {
    expect(parseGenerativeCard({ title: "Weather" })).toEqual({ kind: CARD_KIND_DEFAULT, title: "Weather" });
  });

  it("trims the title, keeps kind/body/fields/links", () => {
    const card = parseGenerativeCard({
      kind: "weather",
      title: "  Nice day  ",
      body: "Sunny, 24°C.",
      fields: [{ label: "Wind", value: "12 km/h" }],
      links: [{ label: "Radar", url: "https://example.com/radar" }],
    });
    expect(card).toEqual({
      kind: "weather",
      title: "Nice day",
      body: "Sunny, 24°C.",
      fields: [{ label: "Wind", value: "12 km/h" }],
      links: [{ label: "Radar", url: "https://example.com/radar" }],
    });
  });

  it("rejects non-objects, arrays, missing/empty/oversized titles", () => {
    expect(parseGenerativeCard(null)).toBeNull();
    expect(parseGenerativeCard("x")).toBeNull();
    expect(parseGenerativeCard([])).toBeNull();
    expect(parseGenerativeCard({})).toBeNull();
    expect(parseGenerativeCard({ title: "" })).toBeNull();
    expect(parseGenerativeCard({ title: "t".repeat(201) })).toBeNull();
  });

  it("rejects an oversized or non-string kind", () => {
    expect(parseGenerativeCard({ title: "a", kind: "k".repeat(41) })).toBeNull();
    expect(parseGenerativeCard({ title: "a", kind: 42 })).toBeNull();
  });

  it("rejects an oversized body", () => {
    expect(parseGenerativeCard({ title: "a", body: "b".repeat(4001) })).toBeNull();
    expect(parseGenerativeCard({ title: "a", body: 42 })).toBeNull();
  });

  it("rejects malformed / oversized fields, whole-card rejection", () => {
    expect(parseGenerativeCard({ title: "a", fields: "nope" })).toBeNull();
    expect(parseGenerativeCard({ title: "a", fields: [null] })).toBeNull();
    expect(parseGenerativeCard({ title: "a", fields: [{ label: "", value: "v" }] })).toBeNull();
    expect(parseGenerativeCard({ title: "a", fields: [{ label: "l", value: 42 }] })).toBeNull();
    expect(parseGenerativeCard({ title: "a", fields: [{ label: "l".repeat(81), value: "v" }] })).toBeNull();
    expect(parseGenerativeCard({ title: "a", fields: [{ label: "l", value: "v".repeat(501) }] })).toBeNull();
    const many = Array.from({ length: 13 }, (_, i) => ({ label: `l${i}`, value: "v" }));
    expect(parseGenerativeCard({ title: "a", fields: many })).toBeNull();
    // One bad entry rejects the WHOLE card (renderer never sees a partial shape).
    expect(parseGenerativeCard({ title: "a", fields: [{ label: "ok", value: "v" }, { label: "" , value: "v" }] })).toBeNull();
  });

  it("rejects non-http(s) or oversized links and malformed entries", () => {
    expect(parseGenerativeCard({ title: "a", links: "nope" })).toBeNull();
    expect(parseGenerativeCard({ title: "a", links: [null] })).toBeNull();
    expect(parseGenerativeCard({ title: "a", links: [{ label: "go", url: "javascript:alert(1)" }] })).toBeNull();
    expect(parseGenerativeCard({ title: "a", links: [{ label: "go", url: "not a url" }] })).toBeNull();
    expect(parseGenerativeCard({ title: "a", links: [{ label: "", url: "https://x.test" }] })).toBeNull();
    expect(parseGenerativeCard({ title: "a", links: [{ label: "go", url: "https://x.test/" + "p".repeat(2048) }] })).toBeNull();
    const many = Array.from({ length: 7 }, (_, i) => ({ label: `l${i}`, url: "https://x.test" }));
    expect(parseGenerativeCard({ title: "a", links: many })).toBeNull();
  });

  it("accepts http links and empty field values", () => {
    expect(
      parseGenerativeCard({ title: "a", links: [{ label: "go", url: "http://x.test" }], fields: [{ label: "l", value: "" }] }),
    ).toEqual({ kind: CARD_KIND_DEFAULT, title: "a", fields: [{ label: "l", value: "" }], links: [{ label: "go", url: "http://x.test" }] });
  });
});

describe("extractToolCard", () => {
  it("plain text and marker-free results are not cards", () => {
    expect(extractToolCard("the answer is 42")).toBeNull();
    expect(extractToolCard("")).toBeNull();
  });

  it("marker inside non-JSON text degrades to null", () => {
    expect(extractToolCard("see yasha_card docs…")).toBeNull();
  });

  it("valid envelope yields the card", () => {
    const result = JSON.stringify({ yasha_card: { kind: "weather", title: "Nice" }, summary: "sunny" });
    expect(extractToolCard(result)).toEqual({ kind: "weather", title: "Nice" });
  });

  it("invalid envelope payload degrades to null", () => {
    expect(extractToolCard(JSON.stringify({ yasha_card: { noTitle: true } }))).toBeNull();
    expect(extractToolCard(JSON.stringify({ other: 1 }))).toBeNull();
  });

  it("JSON that is not an object degrades to null", () => {
    expect(extractToolCard('"yasha_card"')).toBeNull();
    expect(extractToolCard("[1,2]")).toBeNull();
    expect(extractToolCard("null")).toBeNull();
  });
});
