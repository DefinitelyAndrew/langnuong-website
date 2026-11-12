import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";
import { GmailDailyLimitError, sendGmailEmail, sendGmailEmails } from "../_shared/gmail.ts";
import { callSupabaseRpc } from "../_shared/supabase-rpc.ts";

interface AuthEmailPayload {
  user?: { email?: string; new_email?: string };
  email_data?: {
    email_action_type?: string;
    token?: string;
    token_hash?: string;
    token_new?: string;
    token_hash_new?: string;
    redirect_to?: string;
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function verificationLink(tokenHash: string | undefined, action: string, redirectTo: string | undefined): string | null {
  const projectUrl = Deno.env.get("SUPABASE_URL");
  if (!tokenHash || !projectUrl) return null;

  const url = new URL("/auth/v1/verify", projectUrl);
  url.searchParams.set("token", tokenHash);
  url.searchParams.set("type", action);
  if (redirectTo) url.searchParams.set("redirect_to", redirectTo);
  return url.toString();
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let payload: AuthEmailPayload;
  try {
    const secret = Deno.env.get("SEND_EMAIL_HOOK_SECRET");
    if (!secret) throw new Error("Missing SEND_EMAIL_HOOK_SECRET");
    const webhookSecret = secret.replace(/^v1,whsec_/, "");
    const verified = new Webhook(webhookSecret).verify(
      await request.text(),
      Object.fromEntries(request.headers),
    ) as AuthEmailPayload;
    payload = verified;
  } catch (error) {
    console.error("Auth email hook signature verification failed:", error);
    return jsonResponse({ error: "Invalid hook signature" }, 401);
  }

  const email = payload.user?.email;
  const newEmail = payload.user?.new_email;
  const action = payload.email_data?.email_action_type || "email";
  const token = payload.email_data?.token;
  const tokenHash = payload.email_data?.token_hash;
  const tokenNew = payload.email_data?.token_new;
  const tokenHashNew = payload.email_data?.token_hash_new;
  const redirectTo = payload.email_data?.redirect_to;
  if (!email) return jsonResponse({ error: "Hook payload has no recipient email" }, 400);

  const isReservationOtp = redirectTo
    ? new URL(redirectTo).searchParams.get("reservation-otp") === "1"
    : false;
  const isPortalOtp = redirectTo
    ? new URL(redirectTo).searchParams.get("portal-otp") === "1"
    : false;

  // Portal codes are only delivered to allowlisted staff emails. Reservation OTPs
  // are exempt so customer bookings keep working; only the portal redirect triggers
  // the allowlist check. This runs before any email is sent.
  if (isPortalOtp) {
    let allowed = false;
    try {
      allowed = await callSupabaseRpc<boolean>("portal_email_allowed", { p_email: email });
    } catch (error) {
      console.error("Portal allowlist check failed:", error);
      return jsonResponse({ error: "Could not verify portal access" }, 500);
    }
    if (!allowed) {
      return jsonResponse({ error: "This email is not authorized for the portal" }, 403);
    }
  }
  const subjects: Record<string, string> = {
    signup: "Verify your Lang Nuong email",
    invite: "Your Lang Nuong verification code",
    magiclink: "Your Lang Nuong verification code",
    recovery: "Reset your Lang Nuong password",
    email: "Your Lang Nuong verification code",
    reauthentication: "Your Lang Nuong verification code",
    email_change: "Confirm your Lang Nuong email change",
  };
  const subject = isReservationOtp
    ? "Your Lang Nuong verification code"
    : subjects[action] || "Lang Nuong account notification";
  const instruction = action === "recovery"
    ? "Enter this code on the password reset page."
    : action === "email_change"
    ? "Enter this code to confirm your email change."
    : "Enter this code on the verification page to continue.";
  try {
    if (action === "email_change" && newEmail && token && tokenNew) {
      const currentEmailLink = verificationLink(tokenHashNew, action, redirectTo);
      const newEmailLink = verificationLink(tokenHash, action, redirectTo);
      await sendGmailEmails([
        {
          to: email,
          subject,
          text: `Your code to confirm this email change is ${token}.${currentEmailLink ? `\n\nOr confirm here: ${currentEmailLink}` : ""}`,
        },
        {
          to: newEmail,
          subject,
          text: `Your code to confirm this email change is ${tokenNew}.${newEmailLink ? `\n\nOr confirm here: ${newEmailLink}` : ""}`,
        },
      ]);
    } else {
      const recipient = action === "email_change" && newEmail ? newEmail : email;
      const code = token || tokenNew;
      const hash = tokenHash || tokenHashNew;
      const link = isReservationOtp ? null : verificationLink(hash, action, redirectTo);
      const text = code
        ? isReservationOtp
          ? `Your Lang Nuong verification code: ${code}.\n\nEnter this code on the verification page to continue. If you did not request it, you can ignore this email.`
          : `Your Lang Nuong verification code is ${code}.\n\n${instruction}${link ? `\n\nOr continue using this link: ${link}` : ""}\n\nIf you did not request it, you can ignore this email.`
        : `This is a security notification about your Lang Nuong account (${action}). If you did not make this change, please contact us at 9632 6039.`;
      await sendGmailEmail(recipient, subject, text);
    }
    return jsonResponse({}, 200);
  } catch (error) {
    if (error instanceof GmailDailyLimitError) {
      return jsonResponse({ error: "Daily email limit reached. Please try again after midnight Singapore time." }, 429);
    }
    console.error("Could not send Supabase Auth email:", error);
    return jsonResponse({ error: "Email delivery failed" }, 500);
  }
});
