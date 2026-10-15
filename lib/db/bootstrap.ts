import { eq } from "drizzle-orm";
import { auth } from "../auth";
import { db, userCount } from "./index";
import { mcpServers, user } from "./schema";

const ADMIN_EMAIL_SUFFIX = "@yasha.admin";

/** Seeds the first admin from BOOTSTRAP_ADMIN_* env, only while users table is empty. */
export async function seedBootstrapAdmin(): Promise<void> {
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) return;
  if (userCount() > 0) return;

  await auth.api.signUpEmail({
    body: {
      name: username,
      email: `${username.toLowerCase()}${ADMIN_EMAIL_SUFFIX}`,
      password,
      username,
    },
  });
  db.update(user).set({ role: "admin" }).where(eq(user.username, username)).run();
  console.log(`[yasha] bootstrapped admin user "${username}"`);
}

/** Seeds the builtin ketch MCP server row (idempotent; toggling never deletes it). */
export function seedMcpBuiltin(): void {
  const now = new Date();
  db.insert(mcpServers)
    .values({
      id: "ketch",
      builtin: true,
      name: "ketch (web research)",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
}
