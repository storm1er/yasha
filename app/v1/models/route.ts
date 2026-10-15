import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/db";
import { authenticateApiKey, invalidApiKeyResponse, openAiError } from "@/lib/openai-auth";
import { fetchChatModels } from "@/lib/lemonade-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await ensureReady();
  const caller = await authenticateApiKey(req);
  if (!caller) return invalidApiKeyResponse();

  let models;
  try {
    models = await fetchChatModels();
  } catch {
    return openAiError(502, "Upstream model list could not be fetched.", "api_error", "upstream_error");
  }

  return NextResponse.json({
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: m.ownedBy,
    })),
  });
}
