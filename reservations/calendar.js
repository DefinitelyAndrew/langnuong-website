// Calendar file (.ics) for a reservation. Shared by every reservation page so the
// event title format stays identical: "(4 guests) Reservation at Lang Nuong Vietnam".
// Times are Asia/Singapore wall clock, written as UTC instants in the file.
(function () {
  const cfg = window.RESERVATION_CONFIG || {};
  const VENUE_NAME = cfg.VENUE_NAME || 'Lang Nuong Vietnam BBQ & Exclusive';
  const VENUE_ADDRESS = cfg.VENUE_ADDRESS || '271 Jalan Besar Road, Singapore 208941';
  const BRANCHES = window.RESERVATION_BRANCHES || {};

  function venueFor(row) {
    const branch = Object.prototype.hasOwnProperty.call(BRANCHES, row.branch)
      ? BRANCHES[row.branch]
      : null;
    return {
      name: branch ? branch.calendarName : VENUE_NAME,
      address: branch ? branch.address : VENUE_ADDRESS
    };
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function stamp(date) {
    return date.getUTCFullYear() + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate()) +
      'T' + pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + '00Z';
  }

  function durationMinutes(duration) {
    const hours = /(\d+)\s*h/.exec(duration || '');
    const minutes = /(\d+)\s*m/.exec(duration || '');
    return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  }

  function getStartEnd(row) {
    const parts = String(row.reserved_date).split('-').map(Number);
    const [hour, minute] = String(row.reserved_time).split(':').map(Number);
    // Singapore is UTC+8 year round.
    const start = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], hour - 8, minute));
    const end = new Date(start.getTime() + (durationMinutes(row.duration) || 120) * 60000);
    return { start: start, end: end, parts: parts, hour: hour, minute: minute };
  }

  function build(row) {
    const se = getStartEnd(row);
    const start = se.start;
    const end = se.end;
    const guests = Number(row.guests) || 1;
    const venue = venueFor(row);

    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Lang Nuong Group//Reservations//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:' + row.reference + '@langnuong',
      'DTSTAMP:' + stamp(new Date()),
      'DTSTART:' + stamp(start),
      'DTEND:' + stamp(end),
      'SUMMARY:(' + guests + (guests === 1 ? ' guest)' : ' guests)') + ' Reservation at ' + venue.name,
      'LOCATION:' + venue.address,
      'DESCRIPTION:Reference ' + row.reference + ' - ' + guests + ' guests',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n') + '\r\n';
  }

  function googleCalendarUrl(row) {
    const se = getStartEnd(row);
    const guests = Number(row.guests) || 1;
    const venue = venueFor(row);
    const title = '(' + guests + (guests === 1 ? ' guest)' : ' guests)') + ' Reservation at ' + venue.name;
    // Format as YYYYMMDDTHHmmss for local time in Singapore (GMT+8)
    const formatLocal = function (d, hour, minute) {
      return d[0] + pad(d[1]) + pad(d[2]) + 'T' + pad(hour) + pad(minute) + '00';
    };
    const endHour = se.end.getUTCHours() + 8;
    const endMin = se.end.getUTCMinutes();
    // Adjust for day rollover if needed
    let endDate = se.parts.slice();
    let eh = endHour;
    let em = endMin;
    if (eh >= 24) { eh = eh - 24; endDate[2] = endDate[2] + 1; }
    const dates = formatLocal(se.parts, se.hour, se.minute) + '/' + endDate[0] + pad(endDate[1]) + pad(endDate[2]) + 'T' + pad(eh) + pad(em) + '00';
    const details = 'Reference ' + row.reference + ' - ' + guests + ' guests - ' + venue.address;
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: title,
      dates: dates,
      details: details,
      location: venue.address
    });
    return 'https://calendar.google.com/calendar/render?' + params.toString();
  }

  function outlookCalendarUrl(row) {
    const se = getStartEnd(row);
    const guests = Number(row.guests) || 1;
    const venue = venueFor(row);
    const title = '(' + guests + (guests === 1 ? ' guest)' : ' guests)') + ' Reservation at ' + venue.name;
    const details = 'Reference ' + row.reference + ' - ' + guests + ' guests';
    const params = new URLSearchParams({
      path: '/calendar/action/compose',
      rru: 'addevent',
      subject: title,
      startdt: se.start.toISOString(),
      enddt: se.end.toISOString(),
      body: details,
      location: venue.address
    });
    return 'https://outlook.live.com/calendar/0/deeplink/compose?' + params.toString();
  }

  function addToCalendar(row, provider) {
    if (provider === 'google') {
      window.open(googleCalendarUrl(row), '_blank');
    } else if (provider === 'outlook') {
      window.open(outlookCalendarUrl(row), '_blank');
    } else if (provider === 'apple' || provider === 'ics') {
      download(row);
    }
  }

  function download(row) {
    const blob = new Blob([build(row)], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = row.reference + '.ics';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  window.ReservationCalendar = {
    build: build,
    download: download,
    addToCalendar: addToCalendar,
    googleCalendarUrl: googleCalendarUrl,
    outlookCalendarUrl: outlookCalendarUrl,
    venue: { name: VENUE_NAME, address: VENUE_ADDRESS }
  };
})();
