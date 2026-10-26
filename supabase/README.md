# Reservation storage and confirmation email

The booking page writes each reservation to the `public.reservations` table and then
stops. The confirmation emails are sent by Supabase **database webhooks** that fire on
insert and call Brevo's transactional API. Nothing in this repo holds a Brevo key — it
lives in Supabase Vault.

Everything below is dashboard configuration. Only `supabase/reservations.sql` is code.

## 0. One address for everything

All mail uses **`langnuong.reservations@gmail.com`**:

- Brevo **sender** — verify it once under **Senders** and use it for both templates
- Supabase **Authentication → SMTP Settings → Sender email** — the OTP / magic-link sender
- Restaurant notifications from the second webhook go to the same inbox

Replies to a guest confirmation land in that inbox automatically, since it is the
sender. The notification webhook instead sets `replyTo` to the guest's address, so staff
can answer a booking straight from the notification email.

Caveat: a `@gmail.com` sender cannot carry your own SPF/DKIM alignment, so some guest
confirmations will land in spam or promotions. Verifying a domain you own in Brevo and
sending from it later is the reliable fix; the address here is fine to start with.

## 1. Create the table

Supabase → **SQL Editor** → paste `supabase/reservations.sql` → **Run**.

Visitors can insert; nobody anonymous can read the table back. You view bookings under
**Table Editor → reservations**.

## 2. Open the manage pages

Run `supabase/reservation-actions.sql` in the SQL Editor. It adds `manage_token`,
`reserved_label` and `updated_at`, then creates three functions visitors may call:

| Function | Purpose |
|---|---|
| `reservation_get(token)` | returns the one booking behind a link |
| `reservation_cancel(token)` | marks it cancelled, refuses past bookings |
| `reservation_reschedule(token, date, time)` | moves it, enforcing the 3-hour rule |

The table still has **no** read/update policy, so the token only ever reaches its own
row. The pages are:

- `/reservations/manage/reschedule.html?t=<token>`
- `/reservations/manage/cancel.html?t=<token>`

Booking pages mint the token and the printable `reserved_label` when they insert. Both
manage pages also offer **Add to calendar**, which builds a `.ics` titled
`(4 guests) Reservation at Lang Nuong Vietnam` with the address in the location field.

The same file also installs the trigger that emails the guest when this one
reservation is cancelled or moved — see section 6.

## 3. Store the Brevo key

Supabase → **Project Settings → Vault** → **New secret**

- Name: `brevo_api_key`
- Value: your Brevo API key (Brevo → **SMTP & API → API Keys**, not the SMTP key)

## 4. Build the two Brevo templates

Brevo → **Transactional → Templates** → **New template**, one for the guest and one for
the restaurant. Brevo renders `{{ params.x }}` from the webhook body.

Guest template:

```html
<h2>Reservation for Lang Nuong Vietnam</h2>

<p><strong>Where:</strong> {{ params.address }}</p>
<p><strong>When:</strong> {{ params.date }} · {{ params.time }}</p>
<p><strong>No. of Guests:</strong> {{ params.guests }}</p>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0">
  <tr>
    <td style="padding-right:12px">
      <a href="{{ params.reschedule_url }}"
         style="display:inline-block;padding:12px 22px;border-radius:8px;background:#111827;color:#ffffff;text-decoration:none;font-weight:600">Reschedule</a>
    </td>
    <td>
      <a href="{{ params.cancel_url }}"
         style="display:inline-block;padding:12px 22px;border-radius:8px;border:1px solid #d1d5db;color:#374151;text-decoration:none;font-weight:600">Cancel</a>
    </td>
  </tr>
</table>

<p style="font-size:13px;color:#6b7280">Reference {{ params.reference }} · {{ params.duration }} · we hold your table for 15 minutes. Questions? Call 9632 6039.</p>
```

`{{ params.date }}` is the formatted label (`Tuesday, 27 October 2026`), so the weekday is
already included. The two buttons link straight to the manage pages for this booking only.

Suggested restaurant template (plainer, internal):

```html
<h3>New reservation {{ params.reference }}</h3>
<p>{{ params.guest_name }} · {{ params.guests }} guests</p>
<p>{{ params.date }} at {{ params.time }} ({{ params.duration }})</p>
<p>Phone: {{ params.phone }}<br>Email: {{ params.email }}</p>
<p>Notes: {{ params.notes }}</p>
```

Note the template IDs Brevo assigns — you need them in step 4.

## 5. Create the webhooks

Supabase → **Database → Webhooks** → **Create a new hook** (type: *Database*).

### Hook 1 — guest confirmation

- Table: `reservations`
- Events: **Insert**
- Type: **HTTP Request**
- Method: `POST`
- URL: `https://api.brevo.com/v3/smtp/email`
- HTTP headers:
  - `api-key`: `{{ vault.brevo_api_key }}`
  - `Content-Type`: `application/json`
- Body:

```json
{
  "to": [{ "email": "{{ record.email }}", "name": "{{ record.guest_name }}" }],
  "templateId": 1,
  "params": {
    "reference": "{{ record.reference }}",
    "guest_name": "{{ record.guest_name }}",
    "email": "{{ record.email }}",
    "phone": "{{ record.phone }}",
    "guests": "{{ record.guests }}",
    "address": "271 Jalan Besar, Singapore",
    "date": "{{ record.reserved_label }}",
    "time": "{{ record.reserved_time }}",
    "duration": "{{ record.duration }}",
    "notes": "{{ record.notes }}",
    "reschedule_url": "https://definitelyandrew.github.io/langnuong-website/reservations/manage/reschedule.html?t={{ record.manage_token }}",
    "cancel_url": "https://definitelyandrew.github.io/langnuong-website/reservations/manage/cancel.html?t={{ record.manage_token }}"
  }
}
```

### Hook 2 — restaurant notification

Same setup, pointing at the restaurant inbox:

```json
{
  "to": [{ "email": "langnuong.reservations@gmail.com" }],
  "replyTo": { "email": "{{ record.email }}", "name": "{{ record.guest_name }}" },
  "templateId": 2,
  "params": {
    "reference": "{{ record.reference }}",
    "guest_name": "{{ record.guest_name }}",
    "email": "{{ record.email }}",
    "phone": "{{ record.phone }}",
    "guests": "{{ record.guests }}",
    "date": "{{ record.reserved_date }}",
    "time": "{{ record.reserved_time }}",
    "duration": "{{ record.duration }}",
    "notes": "{{ record.notes }}"
  }
}
```

`replyTo` on the restaurant mail makes "Reply" go straight to the guest.

## 6. Cancel and reschedule emails

The trigger `reservation_change_email` (installed by
`supabase/reservation-actions.sql`) fires when a row's `status` becomes `cancelled` or
its date/time moves. It POSTs to Brevo exactly like the webhooks above, using the
`brevo_api_key` from Vault, and sends **only to the guest**. Delivery is best-effort:
if Brevo or Vault fails, the cancel/reschedule still saves and Postgres logs a
warning (visible under Database → Logs).

It needs `pg_net`, which the SQL file enables with
`create extension if not exists pg_net with schema extensions;` (you can also enable
it under **Database → Extensions**).

### Templates 3 and 4

Create two more templates under **Transactional → Templates**.

**Template 3 — subject:** `[Cancel] Reservation for Lang Nuong Vietnam`

```html
<h2>[Cancel] Reservation for Lang Nuong Vietnam</h2>

<p><strong>Where:</strong> {{ params.address }}</p>
<p><strong>When:</strong> <span style="text-decoration:line-through">{{ params.old_date }} · {{ params.old_time }}</span></p>
<p><strong>No. of Guests:</strong> {{ params.guests }}</p>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0">
  <tr>
    <td>
      <a href="{{ params.cancel_url }}"
         style="display:inline-block;padding:12px 22px;border-radius:8px;border:1px solid #d1d5db;color:#374151;text-decoration:none;font-weight:600">Cancel</a>
    </td>
  </tr>
</table>

<p style="font-size:13px;color:#6b7280">Reference {{ params.reference }} · this reservation has been cancelled. Questions? Call 9632 6039.</p>
```

`old_date` · `old_time` is the cancelled slot shown struck through.

**Template 4 — subject:** `[Reschedule] Reservation for Lang Nuong Vietnam`

```html
<h2>[Reschedule] Reservation for Lang Nuong Vietnam</h2>

<p><strong>Where:</strong> {{ params.address }}</p>
<p>
  <strong>When:</strong><br>
  <span style="text-decoration:line-through">{{ params.old_date }} · {{ params.old_time }}</span><br>
  {{ params.new_date }} · {{ params.new_time }}
</p>
<p><strong>No. of Guests:</strong> {{ params.guests }}</p>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0">
  <tr>
    <td style="padding-right:12px">
      <a href="{{ params.reschedule_url }}"
         style="display:inline-block;padding:12px 22px;border-radius:8px;background:#111827;color:#ffffff;text-decoration:none;font-weight:600">Reschedule</a>
    </td>
    <td>
      <a href="{{ params.cancel_url }}"
         style="display:inline-block;padding:12px 22px;border-radius:8px;border:1px solid #d1d5db;color:#374151;text-decoration:none;font-weight:600">Cancel</a>
    </td>
  </tr>
</table>

<p style="font-size:13px;color:#6b7280">Reference {{ params.reference }} · we hold your table for 15 minutes. Questions? Call 9632 6039.</p>
```

The old time is struck through and the new time sits underneath; both buttons link
back to this reservation's manage pages.

### Wire up the IDs

Note the IDs Brevo assigns to templates 3 and 4, put them on the two
`v_template := ...;` lines in `supabase/reservation-actions.sql`, and run the file in
the SQL Editor again (it is safe to re-run).

## 7. Verify it end to end

1. Make a booking on the page. The modal shows a reference like `LN-XXXXXXX`.
2. **Table Editor → reservations** — the row should be there, with a long `manage_token`.
3. Guest inbox should receive the confirmation with working Reschedule and Cancel buttons.
4. `langnuong.reservations@gmail.com` should receive the notification.
5. Brevo → **Transactional → Logs** shows both sends. A `delivered` event there is the
   only proof the mail actually left; a missing row means the webhook never fired
   (check **Database → Webhooks** run history).
6. Open the Reschedule link, move the booking, and confirm the row's `reserved_date`,
   `reserved_time` and `reserved_label` all changed, and that the guest receives the
   `[Reschedule]` email with the old time struck through and the new time below.
7. Open the Cancel link and confirm `status` becomes `cancelled`, the page stops
   offering further changes, and the guest receives the `[Cancel]` email with the
   cancelled time struck through.

## Limits worth knowing

- Webhooks fire after commit and are best-effort — no retry queue. If Brevo is down the
  email is simply lost, though the row is still saved.
- If the webhook is not configured, the page still saves and says a confirmation was
  sent. A missing email is a webhook problem, not a page problem.
- The visitor controls the `email` field, and the reCAPTCHA path skips OTP, so a
  determined person can send mail to an address they do not own. Rate limiting is a
  Brevo/edge-function concern, not something this static page can enforce.
- The `manage_token` is the only key to a booking: anyone who receives the email (or a
  forwarded copy) can reschedule or cancel that one reservation. It cannot reach any
  other row.
- The manage pages hardcode the venue name and address, with `VENUE_NAME` /
  `VENUE_ADDRESS` as config overrides. A second branch needs those set before it is
  accurate.
