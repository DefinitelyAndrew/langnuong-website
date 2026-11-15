(function () {
  var STATUS_URL = 'https://langnuong.statuspage.io/api/v2/status.json';
  var PAGE_URL = 'https://langnuong.statuspage.io';

  var LABELS = {
    none: 'All Systems Operational',
    minor: 'Partial System Issue',
    major: 'Partial System Outage',
    critical: 'Major Outage',
    maintenance: 'Maintenance',
    unknown: 'Status Unavailable'
  };

  function render(wrap, state, description) {
    if (!wrap) return;
    var label = description || LABELS[state] || LABELS.unknown;
    wrap.innerHTML =
      '<a class="site-status-link site-status--' + state +
      '" href="' + PAGE_URL + '" target="_blank" rel="noopener noreferrer" aria-label="System status: ' +
      label.replace(/"/g, '&quot;') + '">' +
      '<span class="site-status-dot" aria-hidden="true"></span>' +
      '<span class="site-status-text">' + label + '</span>' +
      '</a>';
  }

  function init() {
    var wraps = document.querySelectorAll('.site-status-wrap');
    if (!wraps.length) return;

    for (var i = 0; i < wraps.length; i++) {
      render(wraps[i], 'loading', 'Checking status\u2026');
    }

    var url = wraps[0].getAttribute('data-status-url') || STATUS_URL;
    fetch(url, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var indicator = data && data.status && data.status.indicator;
        var description = data && data.status && data.status.description;
        if (!indicator || !LABELS[indicator]) indicator = 'unknown';
        for (var i = 0; i < wraps.length; i++) {
          render(wraps[i], indicator, description);
        }
      })
      .catch(function () {
        for (var i = 0; i < wraps.length; i++) {
          render(wraps[i], 'unknown', 'Status Unavailable');
        }
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
