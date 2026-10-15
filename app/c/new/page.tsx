import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { ChatSurface } from "@/components/chat/chat-surface";

export const dynamic = "force-dynamic";

export default async function NewThreadPage() {
  const session = await getServerSession(await headers());
  if (!session) redirect("/login");
  return <ChatSurface key="new" initialThreadId={null} />;
}
