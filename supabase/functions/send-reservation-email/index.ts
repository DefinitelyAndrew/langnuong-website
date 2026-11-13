import { GmailDailyLimitError, sendGmailEmail } from "../_shared/gmail.ts";
import { callSupabaseRpc } from "../_shared/supabase-rpc.ts";
import { BRANCH_WEBHOOKS, sendDiscordLog } from "../_shared/discord.ts";

interface Reservation {
  reference?: string;
  branch?: string;
  guest_name?: string;
  email?: string;
  phone?: string;
  notes?: string;
  guests?: number;
  reserved_date?: string;
  reserved_time?: string;
  duration?: string;
  manage_token?: string | null;
}

interface ReservationAttachment {
  filename: string;
  content: string;
  contentType: string;
}

interface ReservationEmailPayload {
  action?: string;
  event?: string;
  reservation?: Reservation;
  previous?: { reserved_date?: string; reserved_time?: string };
}

interface QueuedEmail {
  id: number;
  to_email: string;
  subject: string;
  body: string;
}

interface BranchConfig {
  name: string;
  address: string;
  phone: string;
}

const BRANCHES: Record<string, BranchConfig> = {
  exclusive1: {
    name: "Lang Nuong Vietnam BBQ & Exclusive",
    address: "271 Jalan Besar Road, Singapore 208941",
    phone: "9632 6039",
  },
  langnuong1980s: {
    name: "Lang Nuong Vietnam 1980's",
    address: "19 Hamilton Rd, Singapore 209189",
    phone: "9451 2966",
  },
  bodevegetarian: {
    name: "Bo De Vegetarian",
    address: "16 Hamilton Rd, #01-05, Singapore 209186",
    phone: "9179 9368",
  },
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function secretMatches(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("Invalid reservation date");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("en-SG", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

// Used for Discord logs only, so a malformed date must never break the email.
function describeWhen(reservation: Reservation): string {
  try {
    const date = formatDate(requiredText(reservation.reserved_date, "date"));
    const time = requiredText(reservation.reserved_time, "time").slice(0, 5);
    return `${date} at ${time} (SGT)`;
  } catch {
    return [reservation.reserved_date, reservation.reserved_time].filter(Boolean).join(" ") || "—";
  }
}

function requiredText(value: string | undefined, field: string): string {
  if (!value || !value.trim()) throw new Error(`Missing reservation ${field}`);
  return value.trim();
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function icsStamp(date: Date): string {
  return date.getUTCFullYear() + pad2(date.getUTCMonth() + 1) + pad2(date.getUTCDate()) +
    "T" + pad2(date.getUTCHours()) + pad2(date.getUTCMinutes()) + "00Z";
}

function durationMinutes(value?: string): number {
  const hours = /(\d+)\s*h/.exec(value || "");
  const minutes = /(\d+)\s*m/.exec(value || "");
  return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
}

function buildIcs(reservation: Reservation, branch: BranchConfig): string {
  const parts = requiredText(reservation.reserved_date, "date").split("-").map(Number);
  const [hour, minute] = requiredText(reservation.reserved_time, "time").slice(0, 5).split(":").map(Number);
  // Singapore is UTC+8 year round, the same convention as the guest calendar file.
  const start = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], hour - 8, minute));
  const end = new Date(start.getTime() + (durationMinutes(reservation.duration) || 120) * 60000);
  const guests = Number(reservation.guests) || 1;
  const reference = requiredText(reservation.reference, "reference");

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Lang Nuong Group//Reservations//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${reference}@langnuong`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:(${guests} ${guests === 1 ? "guest)" : "guests)"} Reservation at ${branch.name}`,
    `LOCATION:${branch.address}`,
    `DESCRIPTION:Reference ${reference} - ${guests} guests`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n") + "\r\n";
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, character => entities[character]);
}

function htmlBody(text: string): string {
  return '<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">' +
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111827;white-space:pre-wrap;">' +
    escapeHtml(text) +
    "</div></body></html>";
}

function reservationDetails(reservation: Reservation, branch: BranchConfig): string[] {
  const date = formatDate(requiredText(reservation.reserved_date, "date"));
  const time = requiredText(reservation.reserved_time, "time").slice(0, 5);
  const guests = Number(reservation.guests);
  if (!Number.isInteger(guests) || guests < 1) throw new Error("Invalid guest count");
  return [
    `Reference: ${requiredText(reservation.reference, "reference")}`,
    `When: ${date} at ${time} (Singapore time)`,
    `Guests: ${guests}`,
    `Where: ${branch.address}`,
  ];
}

function manageLinks(reservation: Reservation): string[] {
  if (!reservation.manage_token) return [];
  const baseUrl = (Deno.env.get("RESERVATION_SITE_URL") || "https://definitelyandrew.github.io/langnuong-website")
    .replace(/\/+$/, "");
  const token = encodeURIComponent(reservation.manage_token);
  return [
    `Reschedule: ${baseUrl}/reservations/manage/reschedule.html?t=${token}`,
    `Cancel: ${baseUrl}/reservations/manage/cancel.html?t=${token}`,
  ];
}

async function drainReservationEmailQueue(): Promise<number> {
  let processed = 0;
  for (let i = 0; i < 25; i++) {
    const messages = await callSupabaseRpc<QueuedEmail[]>("claim_reservation_email");
    const message = messages[0];
    if (!message) break;

    try {
      await sendGmailEmail(message.to_email, message.subject, message.body);
    } catch (error) {
      const dailyLimit = error instanceof GmailDailyLimitError;
      const finished = await callSupabaseRpc<boolean>("finish_reservation_email", {
        p_id: message.id,
        p_success: false,
        p_daily_limit: dailyLimit,
        p_error: error instanceof Error ? error.message : String(error),
      });
      if (!finished) throw new Error(`Could not release queued reservation email ${message.id}`);
      if (dailyLimit) break;
      console.error(`Queued reservation email ${message.id} failed:`, error);
      await sendDiscordLog("DISCORD_WEBHOOK_RESERVATION_EMAIL", "Queued reservation email failed", [
        { name: "To", value: message.to_email },
        { name: "Subject", value: message.subject },
        { name: "Error", value: error instanceof Error ? error.message : String(error) },
      ], 0xdc2626);
      processed++;
      continue;
    }

    const finished = await callSupabaseRpc<boolean>("finish_reservation_email", {
      p_id: message.id,
      p_success: true,
      p_daily_limit: false,
      p_error: null,
    });
    if (!finished) throw new Error(`Could not mark reservation email ${message.id} as sent`);
    await sendDiscordLog("DISCORD_WEBHOOK_RESERVATION_EMAIL", "Queued reservation email sent", [
      { name: "To", value: message.to_email },
      { name: "Subject", value: message.subject },
    ], 0x22c55e);
    processed++;
  }
  return processed;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const expectedSecret = Deno.env.get("RESERVATION_EMAIL_WEBHOOK_SECRET");
  const receivedSecret = request.headers.get("x-reservation-email-secret") || "";
  if (!expectedSecret || !secretMatches(receivedSecret, expectedSecret)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let payload: ReservationEmailPayload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (payload.action === "drain-queue") {
    try {
      return jsonResponse({ processed: await drainReservationEmailQueue() }, 200);
    } catch (error) {
      console.error("Could not drain reservation email queue:", error);
      return jsonResponse({ error: "Reservation email queue processing failed" }, 500);
    }
  }

  const reservation = payload.reservation;
  if (
    !reservation ||
    !reservation.branch ||
    !Object.prototype.hasOwnProperty.call(BRANCHES, reservation.branch)
  ) {
    return jsonResponse({ error: "Invalid reservation" }, 400);
  }
  const branch = BRANCHES[reservation.branch];
  const event = payload.event;
  if (!["confirmation", "cancelled", "rescheduled"].includes(event || "")) {
    return jsonResponse({ error: "Unsupported email event" }, 400);
  }

  try {
    if ((event === "confirmation" || event === "rescheduled") && !reservation.manage_token) {
      throw new Error("Missing reservation manage token");
    }

    const name = reservation.guest_name?.trim() || "Guest";
    const details = reservationDetails(reservation, branch);
    const links = manageLinks(reservation);
    let subject: string;
    let text: string;
    let attachments: ReservationAttachment[] | undefined;

    if (event === "confirmation") {
      const reference = requiredText(reservation.reference, "reference");
      const date = formatDate(requiredText(reservation.reserved_date, "date"));
      const time = requiredText(reservation.reserved_time, "time").slice(0, 5);
      const guests = Number(reservation.guests);
      if (!Number.isInteger(guests) || guests < 1) throw new Error("Invalid guest count");
      subject = `Your ${branch.name} reservation is confirmed — ${reference}`;
      text = [
        `Hi ${name},`,
        "",
        `Thank you for choosing ${branch.name}. Your reservation is confirmed!`,
        "",
        "Reservation details",
        `Reference: ${reference}`,
        `Date: ${date}`,
        `Time: ${time} (Singapore time)`,
        `Guests: ${guests}`,
        `Location: ${branch.address}`,
        "",
        ...links,
        "",
        `We look forward to welcoming you. If you have any questions, call us at ${branch.phone}.`,
        "",
        branch.name,
      ].join("\n");
      attachments = [{
        filename: `${reference}.ics`,
        content: buildIcs(reservation, branch),
        contentType: "text/calendar",
      }];
    } else if (event === "cancelled") {
      subject = `${branch.name} reservation cancelled — ${requiredText(reservation.reference, "reference")}`;
      text = [
        `Hello ${name},`,
        "",
        "Your reservation has been cancelled.",
        "",
        ...details,
        "",
        `Questions? Call ${branch.phone}.`,
      ].join("\n");
    } else {
      const oldDate = payload.previous?.reserved_date;
      const oldTime = payload.previous?.reserved_time;
      const previousText = oldDate && oldTime
        ? `Previous time: ${formatDate(oldDate)} at ${oldTime.slice(0, 5)} (Singapore time)`
        : "";
      subject = `${branch.name} reservation rescheduled — ${requiredText(reservation.reference, "reference")}`;
      text = [
        `Hello ${name},`,
        "",
        "Your reservation has been rescheduled.",
        ...(previousText ? ["", previousText] : []),
        "",
        ...details,
        ...(links.length ? ["", ...links] : []),
        "",
        `Questions? Call ${branch.phone}.`,
      ].join("\n");
      attachments = [{
        filename: `${requiredText(reservation.reference, "reference")}.ics`,
        content: buildIcs(reservation, branch),
        contentType: "text/calendar",
      }];
    }

    const recipient = requiredText(reservation.email, "email");
    const eventLabel = event === "confirmation"
      ? "Confirmation"
      : event === "cancelled"
      ? "Cancellation"
      : "Reschedule";
    const emailFields = [
      { name: "Reference", value: reservation.reference || "—", inline: true },
      { name: "Branch", value: branch.name, inline: true },
      { name: "To", value: recipient },
    ];

    // A confirmation event is always a freshly inserted reservation, so this is
    // the "new reservation" alert for the branch team.
    if (event === "confirmation") {
      await sendDiscordLog(
        BRANCH_WEBHOOKS[reservation.branch] || "DISCORD_WEBHOOK_EXCLUSIVE",
        `New reservation — ${branch.name}`,
        [
          { name: "Reference", value: reservation.reference || "—", inline: true },
          { name: "Guests", value: String(reservation.guests ?? "—"), inline: true },
          { name: "When", value: describeWhen(reservation), inline: true },
          { name: "Guest", value: reservation.guest_name || "Guest", inline: true },
          { name: "Phone", value: reservation.phone || "—", inline: true },
          { name: "Email", value: recipient },
          ...(reservation.notes ? [{ name: "Notes", value: reservation.notes }] : []),
        ],
        0x22c55e,
      );
    }

    try {
      await sendGmailEmail(recipient, subject, text, attachments, htmlBody(text));
    } catch (error) {
      if (!(error instanceof GmailDailyLimitError)) throw error;
      await callSupabaseRpc<number>("enqueue_reservation_email", {
        p_to_email: recipient,
        p_subject: subject,
        p_body: text,
      });
      await sendDiscordLog("DISCORD_WEBHOOK_RESERVATION_EMAIL", `${eventLabel} email queued (daily limit)`, emailFields, 0xf59e0b);
      return jsonResponse({ queued: true }, 202);
    }
    await sendDiscordLog("DISCORD_WEBHOOK_RESERVATION_EMAIL", `${eventLabel} email sent`, emailFields, 0x22c55e);
    return jsonResponse({ sent: true }, 200);
  } catch (error) {
    console.error("Could not send reservation email:", error);
    await sendDiscordLog("DISCORD_WEBHOOK_RESERVATION_EMAIL", "Reservation email failed", [
      { name: "Reference", value: reservation.reference || "—", inline: true },
      { name: "Event", value: payload.event || "—", inline: true },
      { name: "To", value: reservation.email || "—" },
      { name: "Error", value: error instanceof Error ? error.message : String(error) },
    ], 0xdc2626);
    return jsonResponse({ error: "Email delivery failed" }, 500);
  }
});
