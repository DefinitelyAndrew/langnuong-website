/*
 * Best-effort visit beacon. Posts a short device summary to the Discord visit log
 * on every page view. It never blocks the page and fails silently.
 */
(function () {
  try {
    var host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '') return;
    if (window.__langNuongVisitLogged) return;
    window.__langNuongVisitLogged = true;

    var ENDPOINT = 'https://egggnxmzxbqdsqqlnvig.supabase.co/functions/v1/log-client-event';
    var ua = navigator.userAgent || '';

    function pick(re) {
      var match = re.exec(ua);
      return match ? match[1] : '';
    }

    function sessionId() {
      var key = 'langnuong-visit-session';
      try {
        var existing = sessionStorage.getItem(key);
        if (existing) return { id: existing, fresh: false };
        var created = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem(key, created);
        return { id: created, fresh: true };
      } catch (error) {
        return { id: '', fresh: true };
      }
    }

    function deviceType() {
      var data = navigator.userAgentData;
      if (data && data.mobile) return 'Mobile';
      if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) return 'Tablet';
      if (/Mobi|iPhone|iPod|Android|Windows Phone|IEMobile|Opera Mini/i.test(ua)) return 'Mobile';
      return 'Desktop';
    }

    function browserName() {
      if (/Edg\//.test(ua)) return 'Edge ' + pick(/Edg\/([\d.]+)/);
      if (/OPR\/|Opera/.test(ua)) return 'Opera ' + pick(/(?:OPR|Opera)\/([\d.]+)/);
      if (/SamsungBrowser/.test(ua)) return 'Samsung Internet ' + pick(/SamsungBrowser\/([\d.]+)/);
      if (/CriOS/.test(ua)) return 'Chrome iOS ' + pick(/CriOS\/([\d.]+)/);
      if (/FxiOS/.test(ua)) return 'Firefox iOS ' + pick(/FxiOS\/([\d.]+)/);
      if (/Chrome\//.test(ua)) return 'Chrome ' + pick(/Chrome\/([\d.]+)/);
      if (/Firefox\//.test(ua)) return 'Firefox ' + pick(/Firefox\/([\d.]+)/);
      if (/Safari\//.test(ua)) return 'Safari ' + pick(/Version\/([\d.]+)/);
      return 'Other';
    }

    function osName() {
      if (/Windows NT 10/.test(ua)) return 'Windows 10/11';
      if (/Windows NT 6\.3/.test(ua)) return 'Windows 8.1';
      if (/Windows/.test(ua)) return 'Windows';
      if (/iPhone|iPad|iPod/.test(ua)) return 'iOS ' + pick(/OS (\d+[._]\d+)/).replace('_', '.');
      if (/Android/.test(ua)) return 'Android ' + pick(/Android ([\d.]+)/);
      if (/Mac OS X/.test(ua)) return 'macOS ' + pick(/Mac OS X (\d+[._]\d+)/).replace('_', '.');
      if (/CrOS/.test(ua)) return 'ChromeOS';
      if (/Linux/.test(ua)) return 'Linux';
      return 'Other';
    }

    function connection() {
      var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (!conn) return '';
      return [conn.effectiveType, conn.downlink ? conn.downlink + ' Mbps' : '']
        .filter(Boolean)
        .join(' · ');
    }

    var session = sessionId();
    var payload = {
      event: 'visit',
      page: window.location.pathname + window.location.search,
      title: document.title,
      referrer: document.referrer,
      device: deviceType(),
      browser: browserName(),
      os: osName(),
      screen: screen.width + 'x' + screen.height + ' @' + (window.devicePixelRatio || 1) + 'x',
      viewport: window.innerWidth + 'x' + window.innerHeight,
      language: navigator.language || '',
      timezone: (function () {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        } catch (error) {
          return '';
        }
      })(),
      platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
      touch: navigator.maxTouchPoints > 0 ? 'Yes' : 'No',
      cores: navigator.hardwareConcurrency ? String(navigator.hardwareConcurrency) : '',
      memory: navigator.deviceMemory ? navigator.deviceMemory + ' GB' : '',
      connection: connection(),
      session: session.id,
      newSession: session.fresh
    };

    var body = JSON.stringify(payload);
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: true
    }).catch(function () {});
  } catch (error) {
    /* logging must never break the page */
  }
})();
