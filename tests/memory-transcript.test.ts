// assistantTranscriptText (issue #21 P5): memory extraction keeps assistant
// prose, LABELS gate-validated interactive ask/answers (the answer is the
// user's own speech) and still collapses opaque tool rounds.

import { describe, expect, it } from "vitest";
import { TOOL_OUTPUT_PLACEHOLDER, assistantTranscriptText } from "@/lib/memory/transcript";

const meta = (tools: unknown) => JSON.stringify({ tools });

describe("assistantTranscriptText", () => {
  it("plain content and absent/broken meta pass through", () => {
    expect(assistantTranscriptText("hello", null)).toBe("hello");
    expect(assistantTranscriptText("hello", "not json")).toBe("hello");
    expect(assistantTranscriptText("hello", '{"tools":"x"}')).toBe("hello");
  });

  it("interactive pairs render as labeled dialogue", () => {
    const out = assistantTranscriptText(
      "One moment:",
      meta([
        {
          server: "yasha",
          name: "ask_choice",
          args: JSON.stringify({ question: "Which day?" }),
          result: "Saturday",
          client: true,
          answered: true,
        },
        {
          server: "yasha",
          name: "confirm_action",
          args: "broken json",
          result: "whatever",
          client: true,
          answered: false,
        },
      ])
    );
    expect(out).toContain('asked "Which day?" — user answered "Saturday"');
    expect(out).toContain('asked "" — user answered "(no answer)"');
    expect(out).not.toContain(TOOL_OUTPUT_PLACEHOLDER);
    expect(out.startsWith("One moment:")).toBe(true);
  });

  it("question-less inputs and opaque rounds", () => {
    const out = assistantTranscriptText(
      "",
      meta([
        { server: "yasha", name: "ask_choice", args: "{}", result: "x", client: true, answered: true },
        { server: "yasha", name: "confirm_action", result: "confirmed", client: true, answered: true }, // no args at all
        { server: "ketch", name: "search", args: "{}", result: "third-party text" },
      ])
    );
    expect(out).toContain('asked "" — user answered "x"');
    expect(out).toContain('asked "" — user answered "confirmed"');
    expect(out.startsWith(TOOL_OUTPUT_PLACEHOLDER)).toBe(true); // prose dropped: tool turns may paraphrase output
    // The opaque tool RESULT never leaks into the transcript:
    expect(out).not.toContain("third-party text");
  });
});
