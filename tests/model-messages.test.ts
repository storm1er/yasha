// Unit tests for the OpenAI→ModelMessage converter (M2 seam).

import { describe, expect, it } from "vitest";
import { toModelMessages } from "@/lib/chat/model-messages";

describe("toModelMessages", () => {
  it("maps roles and passes text content through", () => {
    const out = toModelMessages([
      { role: "system", content: "context" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ] as never);
    expect(out).toEqual([
      { role: "system", content: "context" },
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "yo" }] },
    ]);
  });

  it("non-string system content normalizes to empty string", () => {
    expect(toModelMessages([{ role: "system", content: [{ type: "text" }] }] as never)).toEqual([
      { role: "system", content: "" },
    ]);
  });

  it("user null → empty string; parts map image/audio; unknown parts dropped", () => {
    const out = toModelMessages([
      { role: "user", content: null },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          { type: "input_audio", input_audio: { data: "data:audio/wav;base64,BBB", format: "wav" } },
          { type: "mystery" },
        ],
      },
    ] as never);
    expect(out[0]).toEqual({ role: "user", content: "" });
    expect(out[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", image: "data:image/png;base64,AAA" },
        { type: "file", data: "data:audio/wav;base64,BBB", mediaType: "audio/wav" },
      ],
    });
  });

  it("assistant: text + tool calls, tool names recorded for later results", () => {
    const out = toModelMessages([
      {
        role: "assistant",
        content: "calling",
        tool_calls: [{ id: "c1", type: "function", function: { name: "mcp__s__t", arguments: '{"a":1}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "result" },
    ] as never);
    expect(out[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "tool-call", toolCallId: "c1", toolName: "mcp__s__t", input: { a: 1 } },
      ],
    });
    expect(out[1]).toEqual({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "c1", toolName: "mcp__s__t", output: { type: "text", value: "result" } },
      ],
    });
  });

  it("assistant with no representable part becomes empty text", () => {
    expect(toModelMessages([{ role: "assistant", content: "" }] as never)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ]);
    expect(toModelMessages([{ role: "assistant", content: null }] as never)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ]);
  });

  it("tool-call args: invalid JSON or non-object parse to {}", () => {
    const out = toModelMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a", type: "function", function: { name: "t", arguments: "{" } },
          { id: "b", type: "function", function: { name: "t", arguments: "[1,2]" } },
        ],
      },
    ] as never);
    const parts = (out[0] as { content: { input: unknown }[] }).content;
    expect(parts[0].input).toEqual({});
    expect(parts[1].input).toEqual({});
  });

  it("tool result: unknown call id → empty name; non-string content → ''", () => {
    const out = toModelMessages([
      { role: "tool", tool_call_id: "orphan", content: "x" },
      { role: "tool", tool_call_id: "orphan2", content: null },
    ] as never);
    const first = (out[0] as { content: { toolName: string }[] }).content[0];
    expect(first.toolName).toBe("");
    const second = (out[1] as { content: { output: { value: string } }[] }).content[0];
    expect(second.output.value).toBe("");
  });

  it("tool result without a call id: ids and name degrade to empty strings", () => {
    const out = toModelMessages([{ role: "tool", content: "orphan" }] as never);
    expect(out[0]).toEqual({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "", toolName: "", output: { type: "text", value: "orphan" } }],
    });
  });

  it("other roles are dropped", () => {
    expect(toModelMessages([{ role: "developer", content: "x" }] as never)).toEqual([]);
  });
});
