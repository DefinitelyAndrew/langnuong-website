# Reservation storage and confirmation email

The booking page writes each reservation to the `public.reservations` table. The
confirmation and notification emails are sent from the database, so the site keeps
working even when the static page has no server.

## 0. One address for everything

All mail uses `langnuong.reservations@gmail.com` as the recipient. The sender is the
Gmail account on the server, so the site sends to your Google Workspace account with
the Gmail SMTP settings below.

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

## 3. Store the Gmail SMTP password

Supabase → **Project Settings → Vault** → **New secret**

- Name: `gmail_smtp_password`
- Value: your Gmail **app password** (Google Account → Security → 2-Step Verification →
  App passwords → "Mail"). Generate a 16-character app password for your Gmail address,
  not the Gmail account sign-in password.

## 4. Build the two Gmail templates

You create two templates in **Brevo → Transactional → Templates**, then put their IDs on
the two `v_template := ...;` lines in `supabase/reservation-actions.sql` and re-run the
file (it is safe to re-run).

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
    <td>
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

`old_date` · `old_time` is the cancelled/moved slot shown struck through. The old time
is struck through and the new time sits underneath; both buttons link back to this
reservation's manage pages.

**Wire up the IDs.** Note the IDs Brevo assigns to templates 3 and 4, put them on the
two `v_template := ...;` lines, and run the file again.

## 5. Verify it end to end

1. Make a booking on the page. The modal shows a reference like `LN-XXXXXXX`.
2. **Table Editor → reservations** — the row should be there, with a long `manage_token`.
3. Guest inbox receives the confirmation with working Reschedule and Cancel buttons.
4. `langnuong.reservations@gmail.com` receives the notification.
5. Google's outgoing mail log (Google Workspace → Apps → Gmail → Authorization Code);
   Brevo → **Transactional → Logs** shows both sends. A `delivered` event is the only
   proof the mail actually left; a missing row means the webhook never fired.
6. Open the Reschedule link, move the booking, and confirm the row's `reserved_date`,
   `reserved_time` and `reserved_label` all changed, and that the guest receives the
   `[Reschedule]` email with the old time struck through and the new time below.
7. Open the Cancel link and confirm `status` becomes `cancelled`, the page stops
   offering further changes, and the guest receives the `[Cancel]` email with the
   cancelled time struck through.

## Limits worth knowing

- Webhooks fire after commit and are best-effort — no retry queue. If Gmail is down the
  email is simply lost, though the row is still saved.
- If the webhook or function is not configured, the page still saves and says a
  confirmation was sent. A missing email is a side-effect problem, not a page problem.
- The visitor controls the `email` field, and the reCAPTCHA path skips OTP, so a
  determined person can send mail to an address they do not own. Rate limiting is a
  Gmail/edge-function concern, not something this static page can enforce.
- The `manage_token` is the only key to a booking: anyone who receives the email (or a
  forwarded copy) can reschedule or cancel that one reservation. It cannot reach any
  other row.
- The manage pages hardcode the venue name and address, with `VENUE_NAME` /
  `VENUE_ADDRESS` as config overrides. A second branch needs those set before it is
  accurate.
