import { callSupabaseRpc } from "../_shared/supabase-rpc.ts";
import { sendDiscordLog } from "../_shared/discord.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

const OUTCOME_COLORS: Record<string, number> = {
  passed: 0x22c55e,
  failed: 0xdc2626,
  unavailable: 0xf59e0b,
};

/**
 * Only the public site and portal report here, so keep the origins tight rather
 * than leaving an open endpoint that anyone can use to spam the Discord webhooks.
 */
function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin") || "";
  if (!origin) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== "https:" && protocol !== "http:") return false;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".github.io");
  } catch {
    return false;
  }
}

function text(value: unknown, fallback = ""): string {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function headerValue(request: Request, names: string[]): string {
  for (const name of names) {
    const value = request.headers.get(name);
    if (value && value.trim() && value.trim() !== "unknown") return decodeURIComponent(value.trim());
  }
  return "";
}

async function signedInEmail(request: Request): Promise<string> {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) throw new Error("Missing authorization");

  const projectUrl = Deno.env.get("SUPABASE_URL");
  const apikey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!projectUrl) throw new Error("Missing SUPABASE_URL");

  const response = await fetch(`${projectUrl.replace(/\/+$/, "")}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: apikey || token },
  });
  if (!response.ok) throw new Error("Invalid session");
  const user = await response.json();
  const email = typeof user?.email === "string" ? user.email : "";
  if (!email) throw new Error("Invalid session");
  return email;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!isAllowedOrigin(request)) return jsonResponse({ error: "Forbidden" }, 403);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const event = text(body.event).toLowerCase();
  const detail = text(body.detail).slice(0, 500);

  // Page views carry a device summary from the shared on-page beacon.
  if (event === "visit") {
    const page = text(body.page, "/").slice(0, 300);
    const referrer = text(body.referrer, "Direct / none").slice(0, 300);
    const country = headerValue(request, ["cf-ipcountry", "x-vercel-ip-country", "x-country"]);
    const city = headerValue(request, ["cf-ipcity", "cf-city", "x-vercel-ip-city"]);
    const session = text(body.session).slice(0, 64);

    await sendDiscordLog("DISCORD_WEBHOOK_VISITS", `Site visit — ${page}`, [
      { name: "Page", value: page },
      ...(text(body.title) ? [{ name: "Title", value: text(body.title).slice(0, 200) }] : []),
      { name: "Referrer", value: referrer },
      { name: "Device", value: text(body.device, "Unknown").slice(0, 32), inline: true },
      { name: "Browser", value: text(body.browser, "Unknown").slice(0, 64), inline: true },
      { name: "OS", value: text(body.os, "Unknown").slice(0, 64), inline: true },
      { name: "Screen", value: text(body.screen, "—").slice(0, 64), inline: true },
      { name: "Viewport", value: text(body.viewport, "—").slice(0, 64), inline: true },
      { name: "Touch", value: text(body.touch, "—").slice(0, 8), inline: true },
      { name: "Language", value: text(body.language, "—").slice(0, 32), inline: true },
      { name: "Timezone", value: text(body.timezone, "—").slice(0, 64), inline: true },
      { name: "Platform", value: text(body.platform, "—").slice(0, 64), inline: true },
      ...(country || city
        ? [{ name: "Location", value: [city, country].filter(Boolean).join(", "), inline: true }]
        : []),
      { name: "Connection", value: text(body.connection, "—").slice(0, 64), inline: true },
      { name: "CPU / RAM", value: [text(body.cores) ? `${text(body.cores)} cores` : "", text(body.memory)].filter(Boolean).join(" · ") || "—", inline: true },
      ...(session
        ? [{ name: "Session", value: `${session}${body.newSession ? " (new)" : ""}`, inline: true }]
        : []),
    ], 0x3b82f6);

    return jsonResponse({ ok: true }, 200);
  }

  // Successful staff portal sign-ins are an admin-panel audit event. The caller's
  // Supabase session is verified and the portal allowlist is re-checked server side.
  if (event === "portal-login") {
    let email: string;
    try {
      email = await signedInEmail(request);
    } catch {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    try {
      const allowed = await callSupabaseRpc<boolean>("portal_email_allowed", { p_email: email });
      if (!allowed) return jsonResponse({ error: "Not authorized" }, 403);
    } catch (error) {
      console.error("Portal access check failed:", error);
      return jsonResponse({ error: "Could not verify portal access" }, 500);
    }
    await sendDiscordLog("DISCORD_WEBHOOK_MARKETING", "Admin panel sign-in", [
      { name: "Staff", value: email },
      { name: "Page", value: text(body.page, "/portal/").slice(0, 200), inline: true },
      ...(detail ? [{ name: "Detail", value: detail }] : []),
    ], 0x3b82f6);
    return jsonResponse({ ok: true }, 200);
  }

  if (event !== "recaptcha") return jsonResponse({ error: "Unsupported event" }, 400);

  const outcome = text(body.outcome, "unknown").toLowerCase().slice(0, 32);
  await sendDiscordLog(
    "DISCORD_WEBHOOK_RECAPTCHA",
    `reCAPTCHA ${outcome}`,
    [
      { name: "Outcome", value: outcome, inline: true },
      { name: "Branch", value: text(body.branch, "—").slice(0, 64), inline: true },
      { name: "Page", value: text(body.page, "—").slice(0, 200) },
      ...(detail ? [{ name: "Detail", value: detail }] : []),
    ],
    OUTCOME_COLORS[outcome] ?? 0x6b7280,
  );

  return jsonResponse({ ok: true }, 200);
});
