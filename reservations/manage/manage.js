// Shared logic for /reservations/manage/*.html — look up one reservation by its
// manage token, then cancel or move it. Every action is scoped to that single row.
(function () {
  const cfg = window.RESERVATION_CONFIG || {};
  const SUPABASE_URL = cfg.SUPABASE_URL || 'https://egggnxmzxbqdsqqlnvig.supabase.co';
  const SUPABASE_KEY = cfg.SUPABASE_KEY || 'sb_publishable_jostM0x7NIGiLikFjVHLwA_I_x0IpS8';
  const CONTACT_PHONE = cfg.CONTACT_PHONE || '9632 6039';
  const VENUE_NAME = cfg.VENUE_NAME || 'Lang Nuong Vietnam';
  const VENUE_ADDRESS = cfg.VENUE_ADDRESS || '271 Jalan Besar, Singapore';
  const MIN_LEAD_HOURS = 3;
  const BOOKING_WINDOW_MONTHS = 6;

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const SLOT_TIMES = Array.from({ length: 48 }, (_, i) => {
    const minutes = i * 30;
    return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
  });

  let client = null;
  let current = null;

  function $(id) { return document.getElementById(id); }
  function show(id) { $(id).hidden = false; }
  function hide(id) { $(id).hidden = true; }

  function token() {
    return (new URLSearchParams(window.location.search).get('t') || '').trim();
  }

  function getClient() {
    if (client) return client;
    if (!window.supabase || !window.supabase.createClient) return null;
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    return client;
  }

  function setError(id, message) { $(id).textContent = message || ''; }

  function isoDate(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function parseIsoDate(value) {
    const parts = value.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function slotDateTime(dateValue, time) {
    const date = typeof dateValue === 'string' ? parseIsoDate(dateValue) : dateValue;
    const [hour, minute] = time.split(':').map(Number);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
  }

  function isSlotBookable(dateValue, time) {
    return (slotDateTime(dateValue, time).getTime() - Date.now()) / 3600000 >= MIN_LEAD_HOURS;
  }

  function bookableTimes(dateValue) {
    return SLOT_TIMES.filter(t => isSlotBookable(dateValue, t));
  }

  function formatWhen(dateValue, time) {
    const date = parseIsoDate(dateValue);
    return DAYS[date.getDay()] + ', ' + date.getDate() + ' ' + MONTHS[date.getMonth()] + ' ' + date.getFullYear() + ' · ' + time;
  }

  function downloadCalendar(row) {
    if (window.ReservationCalendar && window.ReservationCalendar.addToGoogleCalendar) {
      window.ReservationCalendar.addToGoogleCalendar(row);
    } else if (window.ReservationCalendar) {
      window.ReservationCalendar.download(row);
    }
  }

  function renderSummary(row) {
    $('summaryRef').textContent = row.reference;
    $('summaryWhen').textContent = row.reserved_label && row.reserved_label.trim()
      ? row.reserved_label + ' · ' + row.reserved_time
      : formatWhen(row.reserved_date, row.reserved_time);
    $('summaryGuests').textContent = row.guests + (row.guests === 1 ? ' guest' : ' guests');
    $('summaryDuration').textContent = row.duration;
    $('summaryWhere').textContent = VENUE_ADDRESS;
    if ($('summaryName')) $('summaryName').textContent = row.guest_name;
  }

  function load() {
    const value = token();
    hide('loading');
    if (!value) { show('notFound'); return Promise.resolve(null); }

    const sb = getClient();
    if (!sb) {
      show('notFound');
      setError('error', 'We could not reach the booking system. Please call ' + CONTACT_PHONE + '.');
      return Promise.resolve(null);
    }

    return sb.rpc('reservation_get', { p_token: value }).then(function (result) {
      if (result.error || !result.data) { show('notFound'); return null; }
      current = result.data;
      renderSummary(current);
      if (current.status === 'cancelled') { show('closed'); return current; }
      show('summary');
      return current;
    });
  }

  function mountCancelPage() {
    load().then(function (row) {
      if (!row) return;
      if (row.status === 'cancelled') return;
      show('actions');

      $('calendarBtn').addEventListener('click', () => downloadCalendar(row));

      $('cancelBtn').addEventListener('click', async function () {
        const button = this;
        button.disabled = true;
        button.textContent = 'Cancelling…';
        setError('error', '');
        const result = await getClient().rpc('reservation_cancel', { p_token: token() });
        button.disabled = false;
        button.textContent = 'Cancel this reservation';

        if (result.error) { setError('error', result.error.message); return; }
        if (result.data === 'cancelled') {
          hide('summary');
          hide('actions');
          show('done');
          return;
        }
        const messages = {
          already_cancelled: 'This reservation has already been cancelled.',
          in_past: 'This reservation is in the past, so it cannot be cancelled online. Please call us.',
          not_found: 'We could not find this reservation.'
        };
        setError('error', messages[result.data] || 'We could not cancel this reservation. Please call ' + CONTACT_PHONE + '.');
      });
    });
  }

  function mountReschedulePage() {
    load().then(function (row) {
      if (!row) return;
      if (row.status === 'cancelled') return;
      show('actions');

      const dateInput = $('newDate');
      const timeSelect = $('newTime');
      const saveBtn = $('saveBtn');
      const today = new Date();
      const maxDate = new Date(today.getFullYear(), today.getMonth() + BOOKING_WINDOW_MONTHS, today.getDate());

      dateInput.min = isoDate(today);
      dateInput.max = isoDate(maxDate);
      dateInput.value = row.reserved_date;

      function refreshTimes() {
        const value = dateInput.value;
        const previous = timeSelect.value;
        const times = value ? bookableTimes(value) : [];
        timeSelect.innerHTML = '';
        times.forEach(function (t) {
          const option = document.createElement('option');
          option.value = t;
          option.textContent = t;
          timeSelect.appendChild(option);
        });
        if (row.reserved_date === value && times.indexOf(row.reserved_time) >= 0) {
          timeSelect.value = row.reserved_time;
        } else if (times.indexOf(previous) >= 0) {
          timeSelect.value = previous;
        }
        const nothing = times.length === 0;
        timeSelect.disabled = nothing;
        saveBtn.disabled = nothing;
        $('slotNotice').textContent = nothing
          ? 'No timeslots available on that date. Please pick another day.'
          : times.length + (times.length === 1 ? ' timeslot available.' : ' timeslots available.');
      }

      dateInput.addEventListener('change', refreshTimes);
      refreshTimes();

      $('calendarBtn').addEventListener('click', () => downloadCalendar(row));

      saveBtn.addEventListener('click', async function () {
        const date = dateInput.value;
        const time = timeSelect.value;
        if (!date || !time) { setError('error', 'Pick a date and time first.'); return; }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        setError('error', '');
        const result = await getClient().rpc('reservation_reschedule', { p_token: token(), p_date: date, p_time: time });
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save new time';

        if (result.error) { setError('error', result.error.message); return; }
        if (result.data === 'rescheduled') {
          hide('summary');
          hide('actions');
          $('doneWhen').textContent = formatWhen(date, time);
          show('done');
          return;
        }
        const messages = {
          too_soon: 'That time is less than ' + MIN_LEAD_HOURS + ' hours away. Please pick a later slot.',
          cancelled: 'This reservation has been cancelled, so it cannot be moved.',
          not_found: 'We could not find this reservation.',
          invalid_time: 'That time is not valid.'
        };
        setError('error', messages[result.data] || 'We could not move this reservation. Please call ' + CONTACT_PHONE + '.');
      });
    });
  }

  window.Manage = {
    mountCancelPage: mountCancelPage,
    mountReschedulePage: mountReschedulePage,
    calendarFile: function (row) { return window.ReservationCalendar.build(row); },
    formatWhen: formatWhen,
    bookableTimes: bookableTimes,
    isoDate: isoDate,
    venue: { name: VENUE_NAME, address: VENUE_ADDRESS }
  };
})();
