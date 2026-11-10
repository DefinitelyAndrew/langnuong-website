import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { create } from "https://deno.land/x/djwt@v2.8/mod.ts";

const CALENDAR_ID = "ce5fbc5e1d7e74d886c2d0ff5762580eaf7b787ddded50404cf7959e06d75277@group.calendar.google.com";
const VENUE_NAME = "Lang Nuong Vietnam";
const VENUE_ADDRESS = "271 Jalan Besar, Singapore";
const RESERVATION_BLOCK_MINUTES = 60;
const CALENDAR_API = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;

interface Reservation {
  reference: string;
  branch: string;
  email?: string;
  phone?: string;
  guests?: number;
  reserved_date: string;
  reserved_time: string;
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

async function findEvents(accessToken: string, reference: string): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let pageToken = "";

  do {
    const url = new URL(CALENDAR_API);
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

function buildEvent(reservation: Reservation) {
  const parts = reservation.reserved_date.split("-").map(Number);
  const [hour, minute] = reservation.reserved_time.split(":").map(Number);
  if (parts.length !== 3 || !parts.every(Number.isFinite) || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error("Invalid reservation date or time");
  }

  const startDate = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], hour - 8, minute));
  const endDate = new Date(startDate.getTime() + RESERVATION_BLOCK_MINUTES * 60000);
  const guests = reservation.guests || 1;

  return {
    summary: `(${guests} ${guests === 1 ? "guest)" : "guests)"} Reservation at ${VENUE_NAME}`,
    location: VENUE_ADDRESS,
    description: `Reference ${reservation.reference} - ${guests} guests - ${reservation.email || ""} - ${reservation.phone || ""}`,
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

async function deleteEvent(accessToken: string, eventId: string): Promise<void> {
  const response = await calendarRequest(
    accessToken,
    `${CALENDAR_API}/${encodeURIComponent(eventId)}`,
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
): Promise<void> {
  const existingEvents = await findEvents(accessToken, reservation.reference);

  if (action === "delete") {
    if (existingEvents.length) {
      for (const event of existingEvents) await deleteEvent(accessToken, event.id);
    } else {
      await deleteEvent(accessToken, await eventIdForReference(reservation.reference));
    }
    return;
  }

  const event = buildEvent(reservation);
  if (existingEvents.length) {
    await requireSuccess(
      await calendarRequest(
        accessToken,
        `${CALENDAR_API}/${encodeURIComponent(existingEvents[0].id)}`,
        "PATCH",
        event,
      ),
      "Calendar event update",
    );
    for (const duplicate of existingEvents.slice(1)) await deleteEvent(accessToken, duplicate.id);
    return;
  }

  const eventId = await eventIdForReference(reservation.reference);
  const response = await calendarRequest(accessToken, CALENDAR_API, "POST", { ...event, id: eventId });
  if (response.status === 409) {
    await requireSuccess(
      await calendarRequest(
        accessToken,
        `${CALENDAR_API}/${encodeURIComponent(eventId)}`,
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

    if (!reservation || reservation.branch !== "exclusive1") {
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
      serviceAccount.private_key,
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

    await syncEvent(tokenData.access_token, reservation, action);
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
