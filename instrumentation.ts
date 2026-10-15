export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertConfig } = await import("./lib/config");
    assertConfig();
    const { installExitHooks } = await import("./lib/mcp/client");
    installExitHooks();
    const { ensureReady } = await import("./lib/db");
    await ensureReady();
    const { startWorker } = await import("./lib/jobs/worker");
    startWorker();
  }
}
