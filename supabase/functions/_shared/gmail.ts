import { callSupabaseRpc } from "./supabase-rpc.ts";

const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export class GmailDailyLimitError extends Error {
  constructor() {
    super("The daily email limit has been reached");
    this.name = "GmailDailyLimitError";
  }
}

export interface GmailMessage {
  to: string;
  subject: string;
  text: string;
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeBase64Url(value: string): string {
  return encodeBase64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") || "";
}

function validateEmail(value: string): string {
  if (/[\r\n]/.test(value) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error("Invalid email address");
  }
  return value;
}

export async function sendGmailEmails(messages: GmailMessage[]): Promise<void> {
  if (!messages.length) return;

  const fromEmail = validateEmail(requiredEnv("GMAIL_FROM_EMAIL"));
  const recipients = messages.map(message => validateEmail(message.to));
  const fromName = Deno.env.get("GMAIL_FROM_NAME") || "Lang Nuong Vietnam";
  const clientId = requiredEnv("GMAIL_CLIENT_ID");
  const clientSecret = requiredEnv("GMAIL_CLIENT_SECRET");
  const refreshToken = requiredEnv("GMAIL_REFRESH_TOKEN");

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok || typeof tokenData.access_token !== "string") {
    throw new Error(`Google OAuth token request failed (${tokenResponse.status})`);
  }

  const reserved = await callSupabaseRpc<boolean>("claim_gmail_email_quota", {
    p_count: messages.length,
  });
  if (!reserved) throw new GmailDailyLimitError();

  await Promise.all(messages.map(async (message, index) => {
    const mimeMessage = [
      `From: =?UTF-8?B?${encodeBase64(fromName)}?= <${fromEmail}>`,
      `To: ${recipients[index]}`,
      `Subject: =?UTF-8?B?${encodeBase64(message.subject)}?=`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(encodeBase64(message.text.replace(/\r?\n/g, "\r\n"))),
    ].join("\r\n");

    const response = await fetch(GMAIL_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: encodeBase64Url(mimeMessage) }),
    });
    if (!response.ok) {
      throw new Error(`Gmail API send failed (${response.status}): ${await response.text()}`);
    }
  }));
}

export async function sendGmailEmail(to: string, subject: string, text: string): Promise<void> {
  await sendGmailEmails([{ to, subject, text }]);
}
