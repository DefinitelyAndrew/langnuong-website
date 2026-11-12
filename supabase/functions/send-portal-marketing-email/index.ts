import { GmailDailyLimitError, sendGmailEmail } from "../_shared/gmail.ts";
import { callSupabaseRpc } from "../_shared/supabase-rpc.ts";

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

interface SubscriberRow {
  email: string;
  latest_name: string | null;
  latest_at: string | null;
}

async function getUserEmail(request: Request): Promise<string> {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) throw new Error("Missing authorization");

  const projectUrl = Deno.env.get("SUPABASE_URL");
  const apikey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!projectUrl) throw new Error("Missing SUPABASE_URL");

  const response = await fetch(`${projectUrl.replace(/\/+$/, "")}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: apikey || token,
    },
  });
  if (!response.ok) throw new Error("Invalid session");
  const user = await response.json();
  const email = typeof user?.email === "string" ? user.email : "";
  if (!email) throw new Error("Invalid session");
  return email;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let staffEmail: string;
  try {
    staffEmail = await getUserEmail(request);
  } catch {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  try {
    const allowed = await callSupabaseRpc<boolean>("portal_email_allowed", { p_email: staffEmail });
    if (!allowed) return jsonResponse({ error: "Not authorized" }, 403);
  } catch (error) {
    console.error("Portal access check failed:", error);
    return jsonResponse({ error: "Could not verify portal access" }, 500);
  }

  let body: { subject?: string; text?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  const subject = String(body.subject || "").trim();
  const text = String(body.text || "").trim();
  if (!subject) return jsonResponse({ error: "Subject is required" }, 400);
  if (!text) return jsonResponse({ error: "Message is required" }, 400);

  let subscribers: SubscriberRow[];
  try {
    subscribers = await callSupabaseRpc<SubscriberRow[]>("portal_list_marketing_subscribers_for_send");
  } catch (error) {
    // Fallback: query via REST with service role if helper RPC not present.
    try {
      const projectUrl = Deno.env.get("SUPABASE_URL") || "";
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
      const query = `${projectUrl.replace(/\/+$/, "")}/rest/v1/reservations?select=email,guest_name,created_at&marketing_opt_in=eq.true&email=not.is.null&order=created_at.desc`;
      const response = await fetch(query, {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      });
      if (!response.ok) throw new Error(await response.text());
      const rows = await response.json() as Array<{ email: string; guest_name: string; created_at: string }>;
      const seen = new Set<string>();
      subscribers = [];
      for (const row of rows) {
        const key = String(row.email || "").trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        subscribers.push({ email: String(row.email).trim(), latest_name: row.guest_name, latest_at: row.created_at });
      }
    } catch (inner) {
      console.error("Could not load subscribers:", error, inner);
      return jsonResponse({ error: "Could not load subscribers" }, 500);
    }
  }

  const recipients = Array.from(new Set(
    (subscribers || [])
      .map(row => String(row.email || "").trim().toLowerCase())
      .filter(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  ));

  if (!recipients.length) {
    return jsonResponse({ error: "No opted-in recipients found" }, 400);
  }

  const fromEmail = Deno.env.get("GMAIL_FROM_EMAIL") || "";
  if (!fromEmail) return jsonResponse({ error: "Email sender is not configured" }, 500);

  try {
    // Single message, all opted-in recipients in Bcc so addresses are not exposed to each other.
    const { sendGmailEmails } = await import("../_shared/gmail.ts");
    await sendGmailEmails([{
      to: fromEmail,
      bcc: recipients,
      subject,
      text,
    }]);
    return jsonResponse({ ok: true, sent: recipients.length }, 200);
  } catch (error) {
    if (error instanceof GmailDailyLimitError) {
      return jsonResponse({ error: "Daily email limit reached. Please try again after midnight Singapore time." }, 429);
    }
    console.error("Could not send marketing email:", error);
    return jsonResponse({ error: "Email delivery failed" }, 500);
  }
});
