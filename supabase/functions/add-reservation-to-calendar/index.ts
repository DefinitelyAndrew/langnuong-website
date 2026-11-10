import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { create } from "https://deno.land/x/djwt@v2.8/mod.ts";

const RESERVATION_BLOCK_MINUTES = 60;

interface BranchConfig {
  calendarId: string;
  venueName: string;
  address: string;
}

const BRANCHES: Record<string, BranchConfig> = {
  exclusive1: {
    calendarId: "ce5fbc5e1d7e74d886c2d0ff5762580eaf7b787ddded50404cf7959e06d75277@group.calendar.google.com",
    venueName: "Lang Nuong Vietnam BBQ & Exclusive",
    address: "271A Jalan Besar, Singapore 208941",
  },
  langnuong1980s: {
    calendarId: "61632ee59f8a61cb9de7a035aef0195d83bf140f3f0451535afef70cc64b22b@group.calendar.google.com",
    venueName: "Lang Nuong Vietnam 1980's",
    address: "19 Hamilton Rd, Singapore 209189",
  },
  bodevegetarian: {
    calendarId: "171e4655d1a90f4fbccdbb11c0922055f644eec0b0fd32294f3fcc7669842dd1@group.calendar.google.com",
    venueName: "Bo De Vegetarian",
    address: "16 Hamilton Rd, #01-05, Singapore 209186",
  },
};

interface Reservation {
  reference: string;
  branch: string;
  email?: string;
  phone?: string;
  guests?: number;
  reserved_date: string;
  reserved_time: string;
  notes?: string | null;
}

interface CalendarEvent {
  id: string;
  description?: string;
}

function secretMatches(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i++) {
    difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}

function privateKeyBytes(privateKeyPem: string): Uint8Array {
  const base64 = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(base64);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function calendarRequest(
  accessToken: string,
  url: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function requireSuccess(response: Response, operation: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`${operation} failed (${response.status}): ${await response.text()}`);
  }
}

function calendarApiFor(branch: BranchConfig): string {
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(branch.calendarId)}/events`;
}

async function findEvents(accessToken: string, reference: string, calendarApi: string): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let pageToken = "";

  do {
    const url = new URL(calendarApi);
    url.searchParams.set("q", `Reference ${reference}`);
    url.searchParams.set("maxResults", "2500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await calendarRequest(accessToken, url.toString(), "GET");
    await requireSuccess(response, "Calendar event lookup");
    const result = await response.json();
    events.push(
      ...(result.items || []).filter((event: CalendarEvent) =>
        event.description?.startsWith(`Reference ${reference} -`)
      ),
    );
    pageToken = result.nextPageToken || "";
  } while (pageToken);

  return events;
}

async function eventIdForReference(reference: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(reference));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return `ln${hash}`;
}

function buildEvent(reservation: Reservation, branch: BranchConfig) {
  const parts = reservation.reserved_date.split("-").map(Number);
  const [hour, minute] = reservation.reserved_time.split(":").map(Number);
  if (parts.length !== 3 || !parts.every(Number.isFinite) || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error("Invalid reservation date or time");
  }

  const startDate = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], hour - 8, minute));
  const endDate = new Date(startDate.getTime() + RESERVATION_BLOCK_MINUTES * 60000);
  const guests = reservation.guests || 1;
  const notes = reservation.notes?.trim();

  return {
    summary: `(${guests} ${guests === 1 ? "guest)" : "guests)"} Reservation at ${branch.venueName}`,
    location: branch.address,
    description: [
      `Reference ${reservation.reference} - ${guests} guests - ${reservation.email || ""} - ${reservation.phone || ""}`,
      ...(notes ? [`Notes: ${notes}`] : []),
    ].join("\n"),
    start: {
      dateTime: startDate.toISOString(),
      timeZone: "Asia/Singapore",
    },
    end: {
      dateTime: endDate.toISOString(),
      timeZone: "Asia/Singapore",
    },
    extendedProperties: {
      private: { reservationReference: reservation.reference },
    },
  };
}

async function deleteEvent(accessToken: string, eventId: string, calendarApi: string): Promise<void> {
  const response = await calendarRequest(
    accessToken,
    `${calendarApi}/${encodeURIComponent(eventId)}`,
    "DELETE",
  );
  if (!response.ok && response.status !== 404) {
    await requireSuccess(response, "Calendar event deletion");
  }
}

async function syncEvent(
  accessToken: string,
  reservation: Reservation,
  action: "upsert" | "delete",
  branch: BranchConfig,
): Promise<void> {
  const calendarApi = calendarApiFor(branch);
  const existingEvents = await findEvents(accessToken, reservation.reference, calendarApi);

  if (action === "delete") {
    if (existingEvents.length) {
      for (const event of existingEvents) await deleteEvent(accessToken, event.id, calendarApi);
    } else {
      await deleteEvent(accessToken, await eventIdForReference(reservation.reference), calendarApi);
    }
    return;
  }

  const event = buildEvent(reservation, branch);
  if (existingEvents.length) {
    await requireSuccess(
      await calendarRequest(
        accessToken,
        `${calendarApi}/${encodeURIComponent(existingEvents[0].id)}`,
        "PATCH",
        event,
      ),
      "Calendar event update",
    );
    for (const duplicate of existingEvents.slice(1)) await deleteEvent(accessToken, duplicate.id, calendarApi);
    return;
  }

  const eventId = await eventIdForReference(reservation.reference);
  const response = await calendarRequest(accessToken, calendarApi, "POST", { ...event, id: eventId });
  if (response.status === 409) {
    await requireSuccess(
      await calendarRequest(
        accessToken,
        `${calendarApi}/${encodeURIComponent(eventId)}`,
        "PATCH",
        event,
      ),
      "Calendar event update",
    );
  } else {
    await requireSuccess(response, "Calendar event creation");
  }
}

serve(async (req) => {
  try {
    const expectedSecret = Deno.env.get("RESERVATION_EMAIL_WEBHOOK_SECRET");
    const receivedSecret = req.headers.get("x-reservation-webhook-secret") || "";
    if (!expectedSecret || !secretMatches(receivedSecret, expectedSecret)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        headers: { "Content-Type": "application/json" },
        status: 401,
      });
    }

    const payload = await req.json();
    const reservation = payload.reservation as Reservation | undefined;
    const action = payload.event || "upsert";
    const branch = reservation && Object.prototype.hasOwnProperty.call(BRANCHES, reservation.branch)
      ? BRANCHES[reservation.branch]
      : undefined;

    if (!reservation || !branch) {
      return new Response(JSON.stringify({ skipped: true }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    }
    if (!["upsert", "delete"].includes(action)) {
      return new Response(JSON.stringify({ error: "Unsupported calendar action" }), {
        headers: { "Content-Type": "application/json" },
        status: 400,
      });
    }

    const serviceAccountKey = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
    if (!serviceAccountKey) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");

    const serviceAccount = JSON.parse(serviceAccountKey);
    if (!serviceAccount.client_email || !serviceAccount.private_key) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY must be a service account JSON key");
    }

    const signingKey = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyBytes(serviceAccount.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const now = Math.floor(Date.now() / 1000);
    const jwt = await create(
      { alg: "RS256", typ: "JWT" },
      {
        iss: serviceAccount.client_email,
        scope: "https://www.googleapis.com/auth/calendar",
        aud: "https://oauth2.googleapis.com/token",
        exp: now + 3600,
        iat: now,
      },
      signingKey,
    );

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      throw new Error(`Failed to get Google access token (${tokenResponse.status})`);
    }

    await syncEvent(tokenData.access_token, reservation, action, branch);
    return new Response(JSON.stringify({ success: true, action }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    console.error("Calendar sync failed:", error);
    return new Response(JSON.stringify({ error: "Calendar sync failed" }), {
      headers: { "Content-Type": "application/json" },
      status: 500,
    });
  }
});
