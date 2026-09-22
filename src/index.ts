import qrcode from "qrcode-generator";
import {
  authStatus,
  changePassword,
  getSessionAdmin,
  login,
  logout,
  requireAuth,
  requireCsrf,
} from "./auth";
import type { Env } from "./database";
import { countActiveConnections, logActivity, query, setSetting } from "./database";
import {
  createLink,
  deleteLink,
  ensureDefaultLink,
  findLink,
  listLinks,
  updateLink,
} from "./links";
import {
  assignLinkToSubscription,
  createSubscription,
  deleteSubscription,
  findSubscriptionByKey,
  getPublicSubscriptionData,
  listSubscriptions,
  renderGroupSubscription,
  renderSingleSubscription,
  updateSubscription,
} from "./subscriptions";
import { getActivity, getConnections, getStats } from "./stats";
import { handleTelegramWebhook } from "./telegram";
import { DASHBOARD_HTML, getPublicPageHtml, LOGIN_HTML } from "./pages";
import {
  HttpError,
  errorResponse,
  getPublicOrigin,
  html,
  json,
  readJson,
  text,
} from "./utils";

export type WorkerEnv = Env;

function routePath(request: Request): string {
  return new URL(request.url).pathname.replace(/\/$/, "") || "/";
}

function routeParam(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const value = path.slice(prefix.length).replace(/^\//, "");
  return value ? decodeURIComponent(value) : null;
}

function notImplemented(message: string): Response {
  return json({
    error: "not_implemented",
    message,
    phase: "control-plane",
  }, { status: 501 });
}

async function qrResponse(request: Request): Promise<Response> {
  const data = new URL(request.url).searchParams.get("data") || "";
  if (!data || data.length > 4096) return errorResponse(400, "QR data is missing or too long");
  try {
    const code = qrcode(0, "M");
    code.addData(data);
    code.make();
    const svg = code.createSvgTag({ scalable: true, margin: 2 });
    return new Response(svg, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=3600",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  } catch {
    return errorResponse(400, "unable to generate QR code");
  }
}

async function handleSettings(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    const rows = await query<Record<string, unknown>>(env, "SELECT key, value, updated_at FROM settings ORDER BY key");
    return json({ settings: Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)])) });
  }
  await requireCsrf(request);
  const body = await readJson<Record<string, unknown>>(request);
  const allowed = new Set(["site_name", "timezone", "support_url", "support_github"]);
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key)) continue;
    await setSetting(env, key, String(value).slice(0, 200));
  }
  await logActivity(env, "system", "settings updated", "info");
  return json({ ok: true });
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const path = routePath(request);
  const method = request.method.toUpperCase();

  if (path === "/" && method === "GET") {
    return json({
      service: "Gateway",
      version: "control-plane-1",
      status: "active",
      relay: "not migrated",
      channel: "",
    });
  }

  if (path === "/health" && method === "GET") {
    const connections = await countActiveConnections(env);
    return json({ status: "ok", connections, uptime: "serverless", relay: "not migrated" });
  }

  if (path === "/api/qr" && method === "GET") return qrResponse(request);

  if (path === "/login" && method === "GET") {
    if (await getSessionAdmin(request, env)) return Response.redirect(new URL("/dashboard", request.url), 302);
    return html(LOGIN_HTML);
  }

  if (path === "/dashboard" && method === "GET") {
    await requireAuth(request, env);
    await ensureDefaultLink(env);
    return html(DASHBOARD_HTML);
  }

  if (path === "/test-ws" && method === "GET") {
    return html("<script>location.href='/dashboard'</script>");
  }

  if (path === "/api/login" && method === "POST") return login(request, env);
  if (path === "/api/logout" && method === "POST") {
    await requireAuth(request, env);
    await requireCsrf(request);
    return logout(request, env);
  }
  if (path === "/api/me" && method === "GET") return authStatus(request, env);
  if (path === "/api/change-password" && method === "POST") {
    const admin = await requireAuth(request, env);
    await requireCsrf(request);
    return changePassword(request, env, admin);
  }

  if (path === "/stats" && method === "GET") {
    await requireAuth(request, env);
    return json(await getStats(env));
  }
  if (path === "/api/activity" && method === "GET") {
    await requireAuth(request, env);
    return json(await getActivity(env));
  }
  if (path === "/api/connections" && method === "GET") {
    await requireAuth(request, env);
    return json(await getConnections(env));
  }

  if (path === "/api/settings" && (method === "GET" || method === "PATCH")) {
    await requireAuth(request, env);
    return handleSettings(request, env);
  }

  if (path === "/api/links" && method === "GET") {
    await requireAuth(request, env);
    await ensureDefaultLink(env);
    return json({ links: await listLinks(env, request) });
  }
  if (path === "/api/links" && method === "POST") {
    await requireAuth(request, env);
    await requireCsrf(request);
    return json(await createLink(env, request));
  }
  const linkId = routeParam(path, "/api/links/");
  if (linkId && method === "PATCH") {
    await requireAuth(request, env);
    await requireCsrf(request);
    return updateLink(env, request, linkId);
  }
  if (linkId && method === "DELETE") {
    await requireAuth(request, env);
    await requireCsrf(request);
    return deleteLink(env, linkId);
  }

  if (path === "/api/subs" && method === "GET") {
    await requireAuth(request, env);
    return json({ subs: await listSubscriptions(env, request) });
  }
  if (path === "/api/subs" && method === "POST") {
    await requireAuth(request, env);
    await requireCsrf(request);
    return json(await createSubscription(env, request));
  }
  const subApi = path.match(/^\/api\/subs\/([^/]+)(?:\/links)?$/);
  if (subApi && method === "PATCH" && !path.endsWith("/links")) {
    await requireAuth(request, env);
    await requireCsrf(request);
    return updateSubscription(env, request, decodeURIComponent(subApi[1]));
  }
  if (subApi && method === "DELETE" && !path.endsWith("/links")) {
    await requireAuth(request, env);
    await requireCsrf(request);
    return deleteSubscription(env, decodeURIComponent(subApi[1]));
  }
  const subLinksApi = path.match(/^\/api\/subs\/([^/]+)\/links$/);
  if (subLinksApi && method === "POST") {
    await requireAuth(request, env);
    await requireCsrf(request);
    return assignLinkToSubscription(env, request, decodeURIComponent(subLinksApi[1]));
  }

  const publicSubData = routeParam(path, "/api/public/sub/");
  if (publicSubData && method === "GET") return json(await getPublicSubscriptionData(env, request, publicSubData));

  const singleSub = routeParam(path, "/sub/");
  if (singleSub && method === "GET") return renderSingleSubscription(env, request, singleSub);

  if (path === "/sub-all" && method === "GET") {
    await requireAuth(request, env);
    const links = (await listLinks(env, request)).filter((link) => !link.expired && link.active);
    return text(btoa(links.map((link) => link.vless_link).join("\n")));
  }

  const groupSub = routeParam(path, "/sub-group/");
  if (groupSub && method === "GET") return renderGroupSubscription(env, request, groupSub);

  const publicPage = routeParam(path, "/p/");
  if (publicPage && method === "GET") {
    const group = await findSubscriptionByKey(env, publicPage);
    if (!group) return html("<h2 style='font-family:sans-serif;padding:40px'>گروه پیدا نشد</h2>", { status: 404 });
    return html(getPublicPageHtml(group.uuid_key));
  }

  if (path === "/telegram/webhook" && method === "POST") return handleTelegramWebhook(request, env);

  // The data-plane phase is intentionally not part of this deployment.
  if (path === "/proxy" || path.startsWith("/proxy/")) {
    return notImplemented("HTTP proxy is disabled until it is reviewed and reimplemented with SSRF protection");
  }
  if (path === "/ws" || path.startsWith("/ws/")) {
    return notImplemented("VLESS WebSocket relay is reserved for phase two");
  }
  if (path.startsWith("/xhttp-siz10/")) {
    return notImplemented("XHTTP relay is reserved for phase two");
  }

  if (env.ASSETS) return env.ASSETS.fetch(request);
  return errorResponse(404, "not found");
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.status, error.message);
      console.error(error);
      return errorResponse(500, "internal server error");
    }
  },
};

export default worker;
