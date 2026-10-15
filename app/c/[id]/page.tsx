import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { ChatSurface } from "@/components/chat/chat-surface";

export const dynamic = "force-dynamic";

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(await headers());
  if (!session) redirect("/login");
  const { id } = await params;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) redirect("/c/new");
  return <ChatSurface key={id} initialThreadId={id} />;
}
