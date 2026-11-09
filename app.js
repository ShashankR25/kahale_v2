/*
 * Shared helpers for the KAHALE pages: server calls, safe browser storage,
 * device detection and the QR ticket picture (with Save / Share).
 * Works in every current browser and in the in-app browsers of Instagram,
 * WhatsApp, Facebook, Telegram, etc. (no build step, plain ES5-style code).
 */
(function () {
  'use strict';
  var C = window.KAHALE_CONFIG || {};
  var UA = navigator.userAgent || '';

  var device = {
    ios: /iPhone|iPad|iPod/i.test(UA) || (/Macintosh/i.test(UA) && navigator.maxTouchPoints > 1),
    android: /Android/i.test(UA),
    // Browser built into another app (Instagram, Facebook, WhatsApp, TikTok, Android WebView...).
    inApp: /Instagram|FBAN|FBAV|FB_IAB|FBIOS|Messenger|WhatsApp|Line\/|Snapchat|TikTok|musical_ly|Twitter|Telegram|; wv\)/i.test(UA)
  };
  device.mobile = device.ios || device.android || /Mobi/i.test(UA);

  /* ---------- Storage that never throws (private mode, blocked storage) ---------- */
  var store = {
    get: function (key) {
      try { var v = window.localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
    },
    set: function (key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    remove: function (key) {
      try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
    }
  };

  function newKey() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
      if (window.crypto && window.crypto.getRandomValues) {
        var b = new Uint8Array(16);
        window.crypto.getRandomValues(b);
        var h = '';
        for (var i = 0; i < b.length; i++) h += ('0' + b[i].toString(16)).slice(-2);
        return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
      }
    } catch (e) { /* fall through */ }
    return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  /* ---------- Server calls ---------- */
  var TEMPORARY = /BUSY|simultaneous|too many lock|lock timeout|timed? ?out|network|server error|unavailable|internal error|failed to fetch|load failed|connection|try again later|service invoked too many times/i;

  function once(fn, args, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!C.API_URL) { reject(new Error('API_URL is not set in config.js.')); return; }
      var done = false;
      var controller = null;
      try { controller = typeof AbortController !== 'undefined' ? new AbortController() : null; } catch (e) { controller = null; }
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { if (controller) controller.abort(); } catch (e) { /* ignore */ }
        reject(new Error('network: timed out'));
      }, timeoutMs || 60000);
      var options = { method: 'POST', body: JSON.stringify({ fn: fn, args: args || [] }), redirect: 'follow', credentials: 'omit' };
      if (controller) options.signal = controller.signal;
      fetch(C.API_URL, options)
        .then(function (response) {
          if (!response.ok) throw new Error('server error ' + response.status);
          return response.text();
        })
        .then(function (text) {
          var data;
          try { data = JSON.parse(text); } catch (e) { throw new Error('server error: unexpected answer'); }
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (data && data.ok) resolve(data.result);
          else reject(new Error(data && data.error ? data.error : 'server error'));
        })
        .catch(function (error) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          var text = error && error.message ? error.message : String(error || '');
          reject(new Error(/server error|network/i.test(text) ? text : 'network: ' + text));
        });
    });
  }

  /**
   * Calls a server function; temporary problems (busy, connection lost) are
   * retried automatically, waiting longer each time.
   * arg: the argument object, or a function returning it (called per attempt).
   * options: { retries (default 5), timeoutMs }
   */
  function call(fn, arg, options) {
    options = options || {};
    var retries = options.retries == null ? 5 : options.retries;
    var attempt = 0;
    return new Promise(function (resolve, reject) {
      function run() {
        // arg may be a function, so every retry sends fresh values (e.g. elapsed time).
        once(fn, [typeof arg === 'function' ? arg() : arg], options.timeoutMs).then(resolve, function (error) {
          var text = error && error.message ? error.message : String(error || '');
          var temporary = !text || TEMPORARY.test(text);
          if (temporary && attempt < retries) {
            var wait = 1200 * Math.pow(2, attempt++) + Math.random() * 1000;
            setTimeout(run, Math.min(wait, 20000));
            return;
          }
          var out = new Error(temporary
            ? 'No connection to the server right now. Please check your internet connection - we will try again.'
            : text);
          out.temporary = temporary;
          reject(out);
        });
      }
      run();
    });
  }

  /** Fire-and-forget request that survives the page being closed (used before leaving for PayPal). */
  function beacon(fn, arg) {
    try {
      if (navigator.sendBeacon && C.API_URL) {
        var body = JSON.stringify({ fn: fn, args: [arg] });
        var blob = typeof Blob !== 'undefined' ? new Blob([body], { type: 'text/plain;charset=UTF-8' }) : body;
        return navigator.sendBeacon(C.API_URL, blob);
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /* ---------- Saved tickets on this device ---------- */
  var TICKETS_KEY = 'kahale_my_tickets_v1';
  function rememberTicket(t) {
    if (!t || !t.ticketId) return;
    var list = store.get(TICKETS_KEY) || [];
    list = list.filter(function (x) { return x && x.ticketId !== t.ticketId; });
    list.unshift({ ticketId: t.ticketId, firstName: t.firstName || '', savedAt: Date.now() });
    store.set(TICKETS_KEY, list.slice(0, 10));
  }
  function myTickets() { return (store.get(TICKETS_KEY) || []).filter(function (x) { return x && /^KAH-[0-9A-F]{12}$/.test(x.ticketId); }); }

  /* ---------- QR ticket picture ---------- */
  function drawTicket(canvas, t) {
    var W = 720, H = 1080;
    canvas.width = W;
    canvas.height = H;
    var g = canvas.getContext('2d');
    var qr = window.qrcode(0, 'Q');
    qr.addData(t.ticketId);
    qr.make();
    var n = qr.getModuleCount();

    g.fillStyle = '#11100e'; g.fillRect(0, 0, W, H);
    // header
    g.fillStyle = '#000'; roundRect(g, 30, 30, W - 60, 190, 22); g.fill();
    g.fillStyle = '#d6ad54'; g.fillRect(30, 214, W - 60, 6);
    g.textAlign = 'center';
    g.fillStyle = '#d6ad54'; g.font = '28px Arial, Helvetica, sans-serif';
    g.fillText('✦  ✦  ✦', W / 2, 82);
    g.fillStyle = '#f8e5ad'; g.font = 'bold 42px Arial, Helvetica, sans-serif';
    g.fillText('KARNATAKA RAJYOTSAVA 2026', W / 2, 140);
    g.fillStyle = '#fff7e4'; g.font = '26px Arial, Helvetica, sans-serif';
    g.fillText('KAHALE · ENTRY TICKET', W / 2, 186);
    // card
    g.fillStyle = '#fffdf8'; roundRect(g, 30, 220, W - 60, H - 250, 22); g.fill();
    g.fillStyle = '#861d20'; g.fillRect(30, 220, W - 60, 6);
    // QR
    var size = 480, x0 = (W - size) / 2, y0 = 270;
    g.fillStyle = '#fff'; g.fillRect(x0 - 16, y0 - 16, size + 32, size + 32);
    g.strokeStyle = '#eadfc9'; g.lineWidth = 2; g.strokeRect(x0 - 16, y0 - 16, size + 32, size + 32);
    var cell = size / (n + 8);
    g.fillStyle = '#000';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) g.fillRect(Math.floor(x0 + (c + 4) * cell), Math.floor(y0 + (r + 4) * cell), Math.ceil(cell), Math.ceil(cell));
      }
    }
    g.fillStyle = '#14120f'; g.font = 'bold 46px Consolas, Menlo, monospace';
    g.fillText(t.ticketId, W / 2, y0 + size + 84);
    g.fillStyle = '#861d20'; g.font = 'bold 32px Arial, Helvetica, sans-serif';
    var guests = Number(t.guests) || 0;
    g.fillText(guests ? 'Valid for ' + guests + (guests === 1 ? ' guest' : ' guests') : 'Entry ticket', W / 2, y0 + size + 134);
    g.fillStyle = '#27231e'; g.font = '26px Arial, Helvetica, sans-serif';
    var lines = (t.packages || []).map(function (p) { return p.name + ' × ' + p.quantity; });
    var y = y0 + size + 182;
    lines.slice(0, 4).forEach(function (line) { g.fillText(line, W / 2, y); y += 36; });
    g.fillStyle = '#706960'; g.font = '22px Arial, Helvetica, sans-serif';
    g.fillText((C.EVENT_DATE || '') , W / 2, H - 82);
    g.fillText((C.EVENT_VENUE || ''), W / 2, H - 50);
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (text != null) node.textContent = text;
    return node;
  }

  function ticketUrl(ticketId) {
    var base = location.href.replace(/[?#].*$/, '').replace(/[^\/]*$/, '');
    return base + 'ticket.html?id=' + encodeURIComponent(ticketId);
  }

  /**
   * Shows a ticket: QR picture (long-press / right-click to save), Save button
   * (share sheet on phones, download on computers) and a link to the ticket page.
   */
  function renderTicket(box, t, options) {
    options = options || {};
    box.innerHTML = '';
    var canvas = document.createElement('canvas');
    var img = el('img', { 'class': 'ticket-image', alt: 'Your QR ticket ' + t.ticketId, id: 'ticketImage' });
    var dataUrl = '';
    try {
      drawTicket(canvas, t);
      dataUrl = canvas.toDataURL('image/png');
      img.src = dataUrl;
    } catch (e) {
      box.appendChild(el('p', { 'class': 'message error' }, 'The QR code could not be drawn on this device. Your ticket ID is ' + t.ticketId + ' - it is also in your email.'));
    }
    box.appendChild(img);
    box.appendChild(el('p', { 'class': 'ticket-id' }, t.ticketId));

    var actions = el('div', { 'class': 'ticket-actions' });
    var save = el('button', { type: 'button', 'class': 'save-button', id: 'saveTicket' }, device.mobile ? 'Save ticket to phone' : 'Download ticket (PNG)');
    var note = el('p', { 'class': 'small-note save-note', id: 'saveNote' },
      device.mobile ? 'Or press and hold the ticket picture and choose "Save" / "Add to Photos".'
        : 'Or right-click the ticket picture and choose "Save image".');
    save.addEventListener('click', function () { saveTicket(canvas, dataUrl, t.ticketId, note); });
    actions.appendChild(save);
    if (options.showPageLink !== false) {
      var link = el('a', { href: ticketUrl(t.ticketId), 'class': 'ticket-link', id: 'ticketPageLink' }, 'Open my ticket page');
      actions.appendChild(link);
    }
    box.appendChild(actions);
    box.appendChild(note);
  }

  function filename(ticketId) { return 'KAHALE-ticket-' + ticketId + '.png'; }

  function saveTicket(canvas, dataUrl, ticketId, note) {
    var download = function () {
      // iPhone in-app browsers ignore downloads: there, long-press the picture.
      if (device.ios && device.inApp) {
        note.textContent = 'Press and hold the ticket picture above, then choose "Save to Photos". You can also take a screenshot.';
        note.className = 'small-note save-note highlight';
        return;
      }
      try {
        var a = document.createElement('a');
        a.href = dataUrl;
        a.download = filename(ticketId);
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        note.textContent = device.mobile
          ? 'Saved to your downloads. If you cannot find it, press and hold the ticket picture and choose "Save".'
          : 'Downloaded. You can also right-click the picture and choose "Save image".';
      } catch (e) {
        note.textContent = 'Press and hold (or right-click) the ticket picture and choose "Save".';
      }
      note.className = 'small-note save-note highlight';
    };
    if (!canvas.toBlob || !navigator.share || !device.mobile) { download(); return; }
    canvas.toBlob(function (blob) {
      var file = null;
      try { file = new File([blob], filename(ticketId), { type: 'image/png' }); } catch (e) { file = null; }
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: 'KAHALE ticket ' + ticketId }).then(function () {
          note.textContent = 'Saved / shared. Keep it for the entrance.';
          note.className = 'small-note save-note highlight';
        }, function (error) {
          if (error && error.name === 'AbortError') return; // the user closed the share sheet
          download();
        });
      } else {
        download();
      }
    }, 'image/png');
  }

  function copyText(text, button) {
    var done = function () {
      var old = button.textContent;
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = old; }, 1500);
    };
    var fallback = function () {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { area.setSelectionRange(0, 99999); } catch (e) { /* ignore */ }
      try { if (document.execCommand('copy')) done(); } catch (e) { /* ignore */ }
      document.body.removeChild(area);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  window.Kahale = {
    config: C,
    device: device,
    store: store,
    newKey: newKey,
    call: call,
    beacon: beacon,
    rememberTicket: rememberTicket,
    myTickets: myTickets,
    renderTicket: renderTicket,
    ticketUrl: ticketUrl,
    copyText: copyText,
    el: el
  };
})();
