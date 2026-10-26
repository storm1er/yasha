import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/db";
import { authenticateApiKey, invalidApiKeyResponse, openAiError } from "@/lib/openai-auth";
import { ensureCatalog } from "@/lib/provider/catalog";
import { chatProviders } from "@/lib/provider/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await ensureReady();
  const caller = await authenticateApiKey(req);
  if (!caller) return invalidApiKeyResponse();

  if (chatProviders().length === 0) {
    return openAiError(
      503,
      "No backend is configured. Ask an admin to add one under Settings → Backend.",
      "api_error",
      "no_backend"
    );
  }

  const catalog = await ensureCatalog();
  if (catalog.allUnavailable && catalog.models.length === 0) {
    return openAiError(502, "Upstream model list could not be fetched.", "api_error", "upstream_error");
  }

  return NextResponse.json({
    object: "list",
    data: catalog.models.map((m) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: m.providerId,
    })),
  });
}
