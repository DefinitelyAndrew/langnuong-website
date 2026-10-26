# Reservation storage and confirmation email

The booking page writes each reservation to the `public.reservations` table and then
stops. The confirmation emails are sent by Supabase **database webhooks** that fire on
insert and call Brevo's transactional API. Nothing in this repo holds a Brevo key — it
lives in Supabase Vault.

Everything below is dashboard configuration. Only `supabase/reservations.sql` is code.

## 1. Create the table

Supabase → **SQL Editor** → paste `supabase/reservations.sql` → **Run**.

Visitors can insert; nobody anonymous can read the table back. You view bookings under
**Table Editor → reservations**.

## 2. Store the Brevo key

Supabase → **Project Settings → Vault** → **New secret**

- Name: `brevo_api_key`
- Value: your Brevo API key (Brevo → **SMTP & API → API Keys**, not the SMTP key)

## 3. Build the two Brevo templates

Brevo → **Transactional → Templates** → **New template**, one for the guest and one for
the restaurant. Brevo renders `{{ params.x }}` from the webhook body.

Suggested guest template:

```html
<h2>Your table is confirmed</h2>
<p>Hi {{ params.guest_name }},</p>
<p>We have your reservation at <strong>Lang Nuong Exclusive</strong>, 271 Jalan Besar.</p>
<table cellpadding="6">
  <tr><td><strong>Reference</strong></td><td>{{ params.reference }}</td></tr>
  <tr><td><strong>Date</strong></td><td>{{ params.date }}</td></tr>
  <tr><td><strong>Time</strong></td><td>{{ params.time }}</td></tr>
  <tr><td><strong>Duration</strong></td><td>{{ params.duration }}</td></tr>
  <tr><td><strong>Guests</strong></td><td>{{ params.guests }}</td></tr>
</table>
<p>Please arrive on time — we hold tables for 15 minutes.</p>
<p>To change or cancel, reply to this email or call 9451 2966 / 9632 6039.</p>
```

Suggested restaurant template (plainer, internal):

```html
<h3>New reservation {{ params.reference }}</h3>
<p>{{ params.guest_name }} · {{ params.guests }} guests</p>
<p>{{ params.date }} at {{ params.time }} ({{ params.duration }})</p>
<p>Phone: {{ params.phone }}<br>Email: {{ params.email }}</p>
<p>Notes: {{ params.notes }}</p>
```

Note the template IDs Brevo assigns — you need them in step 4.

## 4. Create the webhooks

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
    "date": "{{ record.reserved_date }}",
    "time": "{{ record.reserved_time }}",
    "duration": "{{ record.duration }}",
    "notes": "{{ record.notes }}"
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

## 5. Verify it end to end

1. Make a booking on the page. The modal shows a reference like `LN-XXXXXXX`.
2. **Table Editor → reservations** — the row should be there with that reference.
3. Guest inbox should receive the confirmation.
4. `langnuong.reservations@gmail.com` should receive the notification.
5. Brevo → **Transactional → Logs** shows both sends. A `delivered` event there is the
   only proof the mail actually left; a missing row means the webhook never fired
   (check **Database → Webhooks** run history).

## Limits worth knowing

- Webhooks fire after commit and are best-effort — no retry queue. If Brevo is down the
  email is simply lost, though the row is still saved.
- If the webhook is not configured, the page still saves and says a confirmation was
  sent. A missing email is a webhook problem, not a page problem.
- The visitor controls the `email` field, and the reCAPTCHA path skips OTP, so a
  determined person can send mail to an address they do not own. Rate limiting is a
  Brevo/edge-function concern, not something this static page can enforce.
