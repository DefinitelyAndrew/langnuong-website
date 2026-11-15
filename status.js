(function () {
  var STATUS_URL = 'https://langnuong.statuspage.io/api/v2/status.json';
  var STATUS_PAGE = 'https://langnuong.statuspage.io/';
  var RETURN_KEY = 'langnuong_status_return';

  function bridgeUrl() {
    var path = window.location.pathname;
    var idx = path.indexOf('/langnuong-website');
    var base = idx >= 0 ? path.slice(0, idx) + '/langnuong-website/' : '/';
    return window.location.origin + base + 'status/?from=' + encodeURIComponent(window.location.href);
  }

  function rememberPage() {
    try { sessionStorage.setItem(RETURN_KEY, window.location.href); } catch (e) {}
    try { localStorage.setItem(RETURN_KEY, window.location.href); } catch (e) {}
  }

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
      '" href="' + bridgeUrl().replace(/"/g, '&quot;') + '" aria-label="System status: ' +
      label.replace(/"/g, '&quot;') + '">' +
      '<span class="site-status-dot" aria-hidden="true"></span>' +
      '<span class="site-status-text">' + label + '</span>' +
      '</a>';
    var link = wrap.querySelector('a.site-status-link');
    if (link) {
      link.addEventListener('click', function () {
        rememberPage();
      });
    }
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
