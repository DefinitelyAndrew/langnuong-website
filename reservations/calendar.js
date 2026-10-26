// Calendar file (.ics) for a reservation. Shared by every reservation page so the
// event title format stays identical: "(4 guests) Reservation at Lang Nuong Vietnam".
// Times are Asia/Singapore wall clock, written as UTC instants in the file.
(function () {
  const cfg = window.RESERVATION_CONFIG || {};
  const VENUE_NAME = cfg.VENUE_NAME || 'Lang Nuong Vietnam';
  const VENUE_ADDRESS = cfg.VENUE_ADDRESS || '271 Jalan Besar, Singapore';

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

  function build(row) {
    const parts = String(row.reserved_date).split('-').map(Number);
    const [hour, minute] = String(row.reserved_time).split(':').map(Number);
    // Singapore is UTC+8 year round.
    const start = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], hour - 8, minute));
    const end = new Date(start.getTime() + (durationMinutes(row.duration) || 120) * 60000);
    const guests = Number(row.guests) || 1;

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
      'SUMMARY:(' + guests + (guests === 1 ? ' guest)' : ' guests)') + ' Reservation at ' + VENUE_NAME,
      'LOCATION:' + VENUE_ADDRESS,
      'DESCRIPTION:Reference ' + row.reference + ' - ' + guests + ' guests - ' + row.duration,
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n') + '\r\n';
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
    venue: { name: VENUE_NAME, address: VENUE_ADDRESS }
  };
})();
