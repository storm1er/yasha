// Reattach an in-flight generation (issue #33, docs/protocol-v3.md §Resume
// streams). This is the URL DefaultChatTransport's reconnectToStream probes
// (GET ${api}/${chatId}/stream) after prepareReconnectToStreamRequest rewrites
// the api to the thread's hub. 204 = nothing in flight (SDK treats it as a
// clean no-resume). Ownership is implicit in the hub key: another user's
// thread id matches no entry. The view replays the whole turn from frame zero
// (`resumeStreamIsReplay`), so a reconnecting client rebuilds the partial
// answer exactly as a live one would see it.

import { NextResponse, type NextRequest } from "next/server";
import { getAuthedUserId } from "@/lib/api-auth";
import { attachReplay, sseResponse } from "@/lib/chat/replay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ threadId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { threadId } = await params;
  const view = attachReplay(userId, threadId);
  if (!view) return new NextResponse(null, { status: 204 });
  return sseResponse(view);
}
