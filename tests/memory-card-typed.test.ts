// Unit coverage for the typed-card entry parser (MEMORY-ENHANCEMENT-PLAN P4).
// Pure function — no db/harness needed.

import { describe, expect, it } from "vitest";
import { CARD_ENTRY_PREFIXES, parseCardEntries } from "@/lib/memory/card";

describe("parseCardEntries", () => {
  it("keeps only prefixed entries, trims, dedupes", () => {
    expect(CARD_ENTRY_PREFIXES).toEqual(["identity", "attribute", "relationship", "rule"]);
    const out = parseCardEntries([
      "identity: Ada Lovelace",
      "  rule: Answer in French  ",
      "traits: too behavioral",
      "attribute:", // prefix only → dropped
      ":x", // no prefix → dropped
      "", // empty → dropped
      "Relationship: Runs acme corp", // case-insensitive prefix check, entry kept verbatim
      "identity: Ada Lovelace", // dup → dropped
      42,
      null,
    ]);
    expect(out).toEqual([
      "identity: Ada Lovelace",
      "rule: Answer in French",
      "Relationship: Runs acme corp",
    ]);
  });

  it("truncates entries at 160 chars", () => {
    const [entry] = parseCardEntries(["identity: " + "x".repeat(200)]);
    expect(entry).toHaveLength(160);
  });

  it("caps the card at 40 entries", () => {
    const items = Array.from({ length: 45 }, (_, i) => `rule: rule ${i}`);
    expect(parseCardEntries(items)).toHaveLength(40);
  });

  it("empty input → empty card", () => {
    expect(parseCardEntries([])).toEqual([]);
  });
});
