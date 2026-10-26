// M1 provider-seam behaviors (docs/provider-plan.md Q22/Q10): zero-provider
// soft state across all model-backed surfaces + control-plane capability answers.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createKey } from "@/lib/api-keys";
import * as adminActions from "@/app/api/admin/actions/route";
import * as adminDownloads from "@/app/api/admin/downloads/route";
import * as adminDownloadsControl from "@/app/api/admin/downloads-control/route";
import * as adminModels from "@/app/api/admin/models/route";
import * as adminOptions from "@/app/api/admin/models/[id]/options/route";
import * as adminRegistry from "@/app/api/admin/registry/route";
import * as adminVariants from "@/app/api/admin/variants/route";
import * as chatRoute from "@/app/api/chat/route";
import * as statusRoute from "@/app/api/backend/status/route";
import * as v1Chat from "@/app/v1/chat/completions/route";
import * as v1Models from "@/app/v1/models/route";
import { ensureReady } from "@/lib/db";
import { providers } from "@/lib/db/schema";
import { completeOnce } from "@/lib/jobs/worker";
import { controlPlaneForAdmin, seedProvidersFromEnv } from "@/lib/provider/registry";
import {
  adminUser,
  callRoute,
  jsonOf,
  makeRequest,
  sessionId,
  signUp,
  type AdminUser,
  type RouteHandler,
  type TestUser,
} from "./support/app";
import { db } from "./support/db";
import { resetHealthProbes } from "@/lib/provider/health";
import { json, mockLemonade, sseCompletion } from "./support/lemonade";

let user: TestUser & { userId: string };
let admin: AdminUser;
let auth: string;

beforeAll(async () => {
  await ensureReady();
  user = Object.assign(await signUp("seam_user"), { userId: "" });
  user.userId = await sessionId(user.cookie);
  admin = await adminUser();
  const created = await createKey(user.userId, "seam");
  auth = `Bearer ${created.key}`;
});

beforeEach(() => {
  db.delete(providers).run();
});

describe("zero wired providers (Q22 soft state)", () => {
  it("POST /api/chat → 503 no_backend", async () => {
    const res = await callRoute(chatRoute.POST as RouteHandler, {
      method: "POST",
      path: "/api/chat",
      cookie: user.cookie,
      json: { message: "hello" },
    });
    expect(res.status).toBe(503);
    expect(await jsonOf(res)).toEqual({ error: "no_backend" });
  });

  it("POST /v1/chat/completions → 503 no_backend", async () => {
    const req = makeRequest({
      method: "POST",
      path: "/v1/chat/completions",
      headers: { authorization: auth },
      json: { model: "m", messages: [{ role: "user", content: "hi" }] },
    });
    const res = await v1Chat.POST(req as never);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("no_backend");
  });

  it("GET /v1/models → 503 no_backend", async () => {
    const req = makeRequest({ method: "GET", path: "/v1/models", headers: { authorization: auth } });
    const res = await v1Models.GET(req as never);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("no_backend");
  });

  it("admin actions passthrough → 503 no_backend after validation", async () => {
    const res = await callRoute(adminActions.POST as RouteHandler, {
      method: "POST",
      path: "/api/admin/actions",
      cookie: admin.cookie,
      json: { action: "load", model: "m" },
    });
    expect(res.status).toBe(503);
    expect(await jsonOf(res)).toEqual({ error: "no_backend" });
  });

  it("every control-plane admin route answers 503 no_backend", async () => {
    const gets: [RouteHandler, string][] = [
      [adminModels.GET as RouteHandler, "/api/admin/models"],
      [adminRegistry.GET as RouteHandler, "/api/admin/registry?q=x"],
      [adminVariants.GET as RouteHandler, "/api/admin/variants?name=x"],
      [adminDownloads.GET as RouteHandler, "/api/admin/downloads"],
    ];
    for (const [handler, path] of gets) {
      const res = await callRoute(handler, { cookie: admin.cookie, path });
      expect(res.status, path).toBe(503);
      expect(await jsonOf(res), path).toEqual({ error: "no_backend" });
    }
    const dlCtl = await callRoute(adminDownloadsControl.POST as RouteHandler, {
      method: "POST",
      path: "/api/admin/downloads-control",
      cookie: admin.cookie,
      json: { id: "d", action: "pause" },
    });
    expect(dlCtl.status).toBe(503);
    expect(await jsonOf(dlCtl)).toEqual({ error: "no_backend" });

    const opts = await callRoute(
      adminOptions.POST as RouteHandler,
      {
        method: "POST",
        path: "/api/admin/models/x/options",
        cookie: admin.cookie,
        json: { options: { ctx_size: 2048 } },
      },
      { params: Promise.resolve({ id: "x" }) }
    );
    expect(opts.status).toBe(503);
    expect(await jsonOf(opts)).toEqual({ error: "no_backend" });
  });

  it("worker completeOnce fails with no_backend", async () => {
    await expect(
      completeOnce({ model: "m", messages: [{ role: "user", content: "x" }], signal: new AbortController().signal })
    ).rejects.toThrow("no_backend");
  });

  it("status probe reports an empty provider list with no rows (and seeds back)", async () => {
    const mock = mockLemonade();
    mock.route("/v1/health", () => json({ status: "ok" }));
    resetHealthProbes();
    const res = await callRoute(statusRoute.GET as RouteHandler, { cookie: user.cookie });
    expect(await jsonOf<{ ok: boolean; providers: unknown[] }>(res)).toEqual({ ok: false, providers: [] });
    seedProvidersFromEnv();
    resetHealthProbes();
    const again = await callRoute(statusRoute.GET as RouteHandler, { cookie: user.cookie });
    const body = await jsonOf<{ providers: { baseUrl: string }[] }>(again);
    expect(body.providers[0]!.baseUrl).toBe("http://lemonade.invalid.test");
  });
});

describe("provider without a control plane answers 501 (Q10)", () => {
  beforeEach(() => {
    db.insert(providers)
      .values({
        id: "compat", type: "openai_compatible", label: "compat", baseUrl: "http://compat.invalid.test",
        apiKey: null, enabled: true, createdAt: new Date(), updatedAt: new Date(),
      })
      .run();
  });

  it("registry lookup distinguishes 'no backend' from 'cannot manage models'", () => {
    expect(controlPlaneForAdmin()).toEqual({ ok: false, error: "provider_lacks_control_plane" });
  });

  it("admin models list → 501 provider_lacks_control_plane", async () => {
    const res = await callRoute(adminModels.GET as RouteHandler, { cookie: admin.cookie });
    expect(res.status).toBe(501);
    expect(await jsonOf(res)).toEqual({ error: "provider_lacks_control_plane" });
  });

  it("every other control-plane admin route answers 501 too", async () => {
    const gets: [RouteHandler, string][] = [
      [adminRegistry.GET as RouteHandler, "/api/admin/registry?q=x"],
      [adminVariants.GET as RouteHandler, "/api/admin/variants?name=x"],
      [adminDownloads.GET as RouteHandler, "/api/admin/downloads"],
    ];
    for (const [handler, path] of gets) {
      const res = await callRoute(handler, { cookie: admin.cookie, path });
      expect(res.status, path).toBe(501);
      expect(await jsonOf(res), path).toEqual({ error: "provider_lacks_control_plane" });
    }
    const dlCtl = await callRoute(adminDownloadsControl.POST as RouteHandler, {
      method: "POST",
      path: "/api/admin/downloads-control",
      cookie: admin.cookie,
      json: { id: "d", action: "pause" },
    });
    expect(dlCtl.status).toBe(501);
    const actions = await callRoute(adminActions.POST as RouteHandler, {
      method: "POST",
      path: "/api/admin/actions",
      cookie: admin.cookie,
      json: { action: "load", model: "m" },
    });
    expect(actions.status).toBe(501);
    const opts = await callRoute(
      adminOptions.POST as RouteHandler,
      {
        method: "POST",
        path: "/api/admin/models/x/options",
        cookie: admin.cookie,
        json: { options: { ctx_size: 2048 } },
      },
      { params: Promise.resolve({ id: "x" }) }
    );
    expect(opts.status).toBe(501);
    const optsGet = await callRoute(
      adminOptions.GET as RouteHandler,
      { path: "/api/admin/models/x/options", cookie: admin.cookie },
      { params: Promise.resolve({ id: "x" }) }
    );
    expect(optsGet.status).toBe(501);
  });

  it("chat runs against the compat provider (no Lemonade needed): 400 no_model_configured", async () => {
    // M2: the compat adapter is wired, so chat is fully functional with only
    // a generic provider — no model is picked in this fixture, hence 400.
    const res = await callRoute(chatRoute.POST as RouteHandler, {
      method: "POST",
      path: "/api/chat",
      cookie: user.cookie,
      json: { message: "hello" },
    });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: "no_model_configured" });
  });
});

describe("multi-provider chat routing (M2b catalog)", () => {
  function insertProvider(id: string) {
    const now = new Date();
    db.insert(providers)
      .values({ id, type: "lemonade", label: id, baseUrl: `http://${id}.invalid.test`, apiKey: null, enabled: true, createdAt: now, updatedAt: now })
      .run();
  }

  it("routes the completion to the provider whose catalog lists the model", async () => {
    insertProvider("alpha");
    insertProvider("beta");
    const mock = mockLemonade();
    mock.route("alpha.invalid.test/v1/models", () => json({ data: [{ id: "a-model", labels: ["chat"], downloaded: true }] }));
    mock.route("beta.invalid.test/v1/models", () => json({ data: [{ id: "b-model", labels: ["chat"], downloaded: true }] }));
    mock.route("alpha.invalid.test/v1/chat/completions", () => new Response("wrong provider", { status: 500 }));
    mock.route("beta.invalid.test/v1/chat/completions", () => sseCompletion("hi from beta"));
    const res = await callRoute(chatRoute.POST as RouteHandler, {
      method: "POST",
      path: "/api/chat",
      cookie: user.cookie,
      json: { message: "hello", model: "beta:b-model" },
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(mock.lastCall("/v1/chat/completions")!.url).toContain("beta.invalid.test");
  });
});
