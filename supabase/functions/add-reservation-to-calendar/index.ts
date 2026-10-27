import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { create } from "https://deno.land/x/djwt@v2.8/mod.ts";

const CALENDAR_ID = "ce5fbc5e1d7e74d886c2d0ff5762580eaf7b787ddded50404cf7959e06d75277@group.calendar.google.com";
const VENUE_NAME = "Lang Nuong Vietnam";
const VENUE_ADDRESS = "271 Jalan Besar, Singapore";

function durationMinutes(duration: string): number {
  const hours = /(\d+)\s*h/.exec(duration || "");
  const minutes = /(\d+)\s*m/.exec(duration || "");
  return (hours ? parseInt(hours[1]) * 60 : 0) + (minutes ? parseInt(minutes[1]) : 0);
}

serve(async (req) => {
  try {
    const { reservation } = await req.json();
    
    if (!reservation || reservation.branch !== "exclusive1") {
      return new Response(JSON.stringify({ skipped: true }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    }

    // Get service account key from environment
    const serviceAccountKey = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
    if (!serviceAccountKey) {
      console.error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
      return new Response(JSON.stringify({ error: "Missing service account key" }), {
        headers: { "Content-Type": "application/json" },
        status: 500,
      });
    }

    const sa = JSON.parse(serviceAccountKey);
    
    // Create JWT
    const now = Math.floor(Date.now() / 1000);
    const jwt = await create(
      { alg: "RS256", typ: "JWT" },
      {
        iss: sa.client_email,
        scope: "https://www.googleapis.com/auth/calendar",
        aud: "https://oauth2.googleapis.com/token",
        exp: now + 3600,
        iat: now,
      },
      sa.private_key
    );

    // Get access token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error("Failed to get access token", tokenData);
      return new Response(JSON.stringify({ error: "Failed to get access token" }), {
        headers: { "Content-Type": "application/json" },
        status: 500,
      });
    }

    // Parse date/time
    const parts = reservation.reserved_date.split("-").map(Number);
    const [hour, minute] = reservation.reserved_time.split(":").map(Number);
    const duration = durationMinutes(reservation.duration || "2h");
    
    // Create start and end in Singapore time (UTC+8)
    const startDate = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], hour - 8, minute));
    const endDate = new Date(startDate.getTime() + duration * 60000);
    
    const guests = reservation.guests || 1;
    const event = {
      summary: `(${guests} ${guests === 1 ? "guest)" : "guests)"} Reservation at ${VENUE_NAME}`,
      location: VENUE_ADDRESS,
      description: `Reference ${reservation.reference} - ${guests} guests - ${reservation.email} - ${reservation.phone}`,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: "Asia/Singapore",
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: "Asia/Singapore",
      },
    };

    // Create event
    const eventRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${tokenData.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
      }
    );

    const eventData = await eventRes.json();
    if (!eventRes.ok) {
      console.error("Failed to create event", eventData);
      return new Response(JSON.stringify({ error: "Failed to create event", details: eventData }), {
        headers: { "Content-Type": "application/json" },
        status: 500,
      });
    }

    return new Response(JSON.stringify({ success: true, eventId: eventData.id }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { "Content-Type": "application/json" },
      status: 500,
    });
  }
});
