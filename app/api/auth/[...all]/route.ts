import { auth } from "@/lib/auth";
import { ensureReady } from "@/lib/db";

export async function All(req: Request): Promise<Response> {
  await ensureReady();
  return auth.handler(req);
}

export const GET = All;
export const POST = All;
