/*
 * Registration page: fill in -> pay with PayPal -> come back -> the page finds
 * the payment by itself, submits and shows the QR ticket.
 *
 * Coming back works in every case:
 *  - the tab stayed open (computers, most phones): checks start as soon as the
 *    page is visible again;
 *  - the browser reloaded or threw the page away (iPhone, Instagram, WhatsApp...):
 *    the form is saved in the browser AND the page address carries a key (?r=...),
 *    so reopening it restores everything from the browser or from the server;
 *  - everything was lost: "I have already paid" finds the payment by the exact
 *    PayPal name;
 *  - the payment cannot be found: "organisers will check my payment" saves the
 *    registration as Pending.
 */
(function () {
  'use strict';
  var K = window.Kahale;
  var C = K.config;
  var D = K.device;

  var STATE_KEY = 'kahale_registration_v2';
  var STATE_HOURS = 24;
  var FIELDS = ['firstName', 'lastName', 'email', 'emailConfirm', 'student', 'university',
    'entryQty', 'dinnerQty', 'snackQty', 'dealQty'];
  var QTY = ['entryQty', 'dinnerQty', 'snackQty', 'dealQty'];
  var PACKAGE_NAMES = { entryQty: 'Entry Pass', dinnerQty: 'Entry Pass with Dinner',
    snackQty: 'Entry Pass with Snacks', dealQty: 'Deal of the Day' };

  var $ = function (id) { return document.getElementById(id); };
  var form = $('registrationForm');
  var rules = $('rulesAccepted');

  // Everything about the registration in progress (saved in the browser).
  var S = {
    key: null,          // random registration key (also in the address: ?r=key)
    phase: 'form',      // form | waiting | submitting | done
    payCents: null,     // total PayPal was opened for
    clickedAt: null,    // when "Pay with PayPal" was clicked (this device's clock)
    sessionId: null,    // server payment session
    beaconSent: false,  // startPayment sent while leaving the page (answer unknown)
    alreadyPaid: false  // "I have already paid" (no PayPal click on this device)
  };
  var checking = false;
  var checkTimer = null;
  var checkingSince = null;
  var checks = 0;
  var stopped = false;
  var sessionPromise = null;
  var submitting = false;

  /* ---------------- helpers ---------------- */

  function totalCents() {
    return QTY.reduce(function (sum, name) {
      var el = form.elements[name];
      return sum + (Number(el.value) || 0) * Number(el.getAttribute('data-price'));
    }, 0);
  }
  function euro(cents) { return (cents / 100).toFixed(2); }
  function euroLocal(cents) { return euro(cents).replace('.', ','); }
  function amountInWords(cents) {
    var e = Math.floor(cents / 100), c = cents % 100;
    return e + (e === 1 ? ' euro' : ' euros') + (c ? ' and ' + c + (c === 1 ? ' cent' : ' cents') : '');
  }
  function setText(selector, text) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), function (n) { n.textContent = text; });
  }
  function param(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function setUrlKey(key) {
    try { history.replaceState(null, '', location.pathname + (key ? '?r=' + encodeURIComponent(key) : '')); } catch (e) { /* ignore */ }
  }
  function ensureKey() {
    if (!S.key) S.key = K.newKey();
    return S.key;
  }

  /* ---------------- saved progress ---------------- */

  function saveState() {
    if (S.phase === 'done') { K.store.remove(STATE_KEY); return; }
    var fields = {};
    FIELDS.forEach(function (n) { fields[n] = form.elements[n].value; });
    K.store.set(STATE_KEY, {
      v: 2, savedAt: Date.now(), fields: fields, rules: rules.checked,
      key: S.key, phase: S.phase, payCents: S.payCents, clickedAt: S.clickedAt,
      sessionId: S.sessionId, beaconSent: S.beaconSent, alreadyPaid: S.alreadyPaid
    });
  }

  function loadState() {
    var st = K.store.get(STATE_KEY);
    if (!st || st.v !== 2 || !st.fields || !(Date.now() - st.savedAt < STATE_HOURS * 3600 * 1000)) {
      K.store.remove(STATE_KEY);
      return null;
    }
    return st;
  }

  function fillFields(fields) {
    FIELDS.forEach(function (n) {
      var el = form.elements[n];
      if (!el || fields[n] == null) return;
      el.value = String(fields[n]);
      if (el.tagName === 'SELECT' && el.value !== String(fields[n])) el.selectedIndex = 0;
    });
  }

  /* ---------------- PayPal links ---------------- */

  // The Android PayPal app reads the amount in German format ("2,99"); the iPhone
  // app only understands "2.99"; the PayPal website accepts both.
  function paypalLinkAmount(cents) { return D.android ? euroLocal(cents) : euro(cents); }

  // Short paypal.me link WITHOUT currency: the PayPal app opens with the amount filled in.
  function paypalUrl(cents) {
    return 'https://paypal.me/' + encodeURIComponent(C.PAYPAL_ME_USERNAME) + '/' + paypalLinkAmount(cents);
  }

  // PayPal website (never the app): on phones the app takes over paypal.me links,
  // but not the login page, which then continues to the payment page.
  function paypalWebUrl(cents) {
    var page = '/paypalme/' + encodeURIComponent(C.PAYPAL_ME_USERNAME) + '/' + euroLocal(cents);
    if (!D.mobile) return 'https://www.paypal.com' + page;
    return 'https://www.paypal.com/signin?returnUri=' + encodeURIComponent(page);
  }

  // iPhones and in-app browsers handle new tabs badly (blank page on return,
  // closed with the in-app browser): PayPal opens in this tab and Back returns here.
  var SAME_TAB = D.ios || D.inApp;

  function openSameTab(url) {
    var a = document.createElement('a');
    a.href = url;
    a.target = '_self';
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function openNewTab(url, web) {
    var tab = null;
    try { tab = window.open(web && D.android ? '' : url, '_blank'); } catch (e) { tab = null; }
    if (!tab) return false;
    try { tab.opener = null; } catch (e) { /* ignore */ }
    if (web && D.android) {
      // Android hands tapped links to the PayPal app, but not pages that move on
      // by themselves: an empty tab that forwards to PayPal stays in the browser.
      try {
        var safe = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        tab.document.open();
        tab.document.write('<!DOCTYPE html><html><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width, initial-scale=1">' +
          '<meta http-equiv="refresh" content="0; url=' + safe + '"><title>PayPal</title></head>' +
          '<body style="font-family:Arial,sans-serif;padding:24px;text-align:center">' +
          '<p>Opening PayPal&hellip;</p><p><a href="' + safe + '">Tap here if PayPal does not open</a></p></body></html>');
        tab.document.close();
      } catch (e) {
        try { tab.location.href = url; } catch (e2) { return false; }
      }
    }
    return true;
  }

  /* ---------------- validation ---------------- */

  function emailsMatch() {
    return form.elements.email.value.trim().toLowerCase() === form.elements.emailConfirm.value.trim().toLowerCase();
  }
  function updateEmailMatch() {
    var note = $('emailMatchNote');
    var typed = form.elements.emailConfirm.value.trim() !== '';
    var ok = emailsMatch();
    form.elements.emailConfirm.setCustomValidity(typed && !ok ? 'The two email addresses do not match.' : '');
    note.textContent = !typed ? '' : ok ? '✔ Email addresses match' : '✖ The email addresses do not match';
    note.className = 'email-match' + (!typed ? '' : ok ? ' ok' : ' bad');
  }

  function showMessage(text, type) {
    var m = $('message');
    m.textContent = text || '';
    m.className = 'message' + (type ? ' ' + type : '');
  }

  // All fields filled correctly and the rules ticked? Shows what is missing.
  function validate() {
    showMessage('');
    updateEmailMatch();
    if (totalCents() <= 0) {
      showMessage('Please select at least one package.', 'error');
      $('entryQty').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }
    if (typeof form.reportValidity === 'function') {
      if (!form.reportValidity()) return false;
    } else {
      var bad = FIELDS.concat(['rulesAccepted']).filter(function (n) {
        var el = form.elements[n];
        return el && el.required && (el.type === 'checkbox' ? !el.checked : !String(el.value).trim());
      })[0];
      if (bad) {
        showMessage('Please fill in all required fields.', 'error');
        form.elements[bad].focus();
        return false;
      }
      if (!emailsMatch()) { showMessage('The two email addresses do not match.', 'error'); return false; }
    }
    return true;
  }

  /* ---------------- server data ---------------- */

  function formData() {
    var d = { registrationKey: S.key, transactionId: '' };
    FIELDS.forEach(function (n) { d[n] = form.elements[n].value; });
    QTY.forEach(function (n) { d[n] = Number(d[n]) || 0; });
    d.paymentSessionId = S.payCents === totalCents() ? S.sessionId : null;
    return d;
  }

  function startData(previousSessionId) {
    var clickedAt = S.clickedAt;
    return function () {
      var d = formData();
      d.previousSessionId = previousSessionId || null;
      d.elapsedMs = Math.max(0, Date.now() - clickedAt);
      return d;
    };
  }

  function packagesFromForm() {
    return QTY.map(function (n) { return { name: PACKAGE_NAMES[n], quantity: Number(form.elements[n].value) || 0 }; })
      .filter(function (p) { return p.quantity > 0; });
  }

  /* ---------------- payment session ---------------- */

  // Makes sure the server knows when "Pay with PayPal" was clicked (needed for
  // partial-name matching). Never fails: exact-name matching works without it.
  function ensureSession() {
    if (S.sessionId || !S.clickedAt || S.payCents !== totalCents()) return Promise.resolve();
    if (sessionPromise) return sessionPromise;
    var cents = S.payCents;
    var key = S.key;
    var p = Promise.resolve(null);
    if (S.beaconSent) {
      // The start was sent while the page was being left: ask for its result.
      p = K.call('resumePayment', { registrationKey: key }, { retries: 2 }).then(function (res) {
        return res && res.found && res.paymentSessionId ? res.paymentSessionId : null;
      }, function () { return null; });
    }
    sessionPromise = p.then(function (id) {
      if (id) return id;
      return K.call('startPayment', startData(null), { retries: 3 }).then(function (r) {
        return r && r.paymentSessionId;
      }, function () { return null; });
    }).then(function (id) {
      sessionPromise = null;
      if (id && S.key === key && S.payCents === cents && !S.sessionId) {
        S.sessionId = id;
        S.beaconSent = false;
        saveState();
      }
    });
    return sessionPromise;
  }

  /* ---------------- pay ---------------- */

  function pay(web) {
    if (!validate()) return;
    var cents = totalCents();
    var previous = S.phase === 'waiting' && S.payCents === cents ? S.sessionId : null;
    ensureKey();
    S.phase = 'waiting';
    S.payCents = cents;
    S.clickedAt = Date.now();
    S.sessionId = null;
    S.beaconSent = false;
    S.alreadyPaid = false;
    resetChecks();
    var url = web ? paypalWebUrl(cents) : paypalUrl(cents);

    if (SAME_TAB) {
      // This page is left now: the beacon reaches the server even then.
      var data = startData(previous)();
      S.beaconSent = K.beacon('startPayment', data);
      saveState();
      setUrlKey(S.key);
      render();
      setStatus('Opening PayPal… After paying, come back to this page (Back button) — your payment is then found automatically.');
      if (!S.beaconSent) ensureSession();
      openSameTab(url);
      // If PayPal opened in its app and this page stayed, keep checking.
      schedule(12000);
      return;
    }

    var opened = openNewTab(url, web);
    saveState();
    setUrlKey(S.key);
    render();
    ensureSession();
    if (!opened) {
      openSameTab(url);
      return;
    }
    setStatus('PayPal opened in a new tab. Pay there, then come back to this tab — your payment is found automatically.');
    schedule(10000);
  }

  function alreadyPaid() {
    if (!validate()) return;
    ensureKey();
    S.phase = 'waiting';
    S.payCents = totalCents();
    S.clickedAt = null;
    S.sessionId = null;
    S.beaconSent = false;
    S.alreadyPaid = true;
    resetChecks();
    saveState();
    setUrlKey(S.key);
    render();
    check(true);
  }

  function backToForm() {
    if (!S.alreadyPaid && !window.confirm('Only change your order if you have NOT paid yet. If you already paid, please keep the same packages. Continue?')) return;
    S.phase = 'form';
    S.sessionId = null;
    S.clickedAt = null;
    S.payCents = null;
    S.beaconSent = false;
    S.alreadyPaid = false;
    resetChecks();
    saveState();
    render();
    $('paymentSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------------- automatic checks ---------------- */

  function resetChecks() {
    clearTimeout(checkTimer);
    checkTimer = null;
    checkingSince = null;
    checks = 0;
    stopped = false;
    $('waitProblem').textContent = '';
    $('pendingOffer').hidden = true;
  }

  // text: full status in the panel; short: the line in the floating bar.
  function setStatus(text, short) {
    $('waitStatus').textContent = text;
    $('statusBarText').textContent = short || (S.phase === 'submitting' ? 'Saving your registration…' : 'Checking your payment…');
  }

  // The floating bar only shows while the payment panel is scrolled out of view.
  var panelInView = false;
  function updateBar() {
    var waiting = S.phase === 'waiting' || S.phase === 'submitting';
    $('statusBar').hidden = !waiting || panelInView;
  }
  if (typeof IntersectionObserver !== 'undefined') {
    new IntersectionObserver(function (entries) {
      panelInView = entries[0].isIntersecting;
      updateBar();
    }).observe($('waitPanel'));
  }

  function schedule(delay) {
    clearTimeout(checkTimer);
    if (S.phase !== 'waiting' || stopped) return;
    if (delay == null) {
      var since = checkingSince ? Date.now() - checkingSince : 0;
      if (since > C.CHECK_STOP_AFTER_MS) { stop(); return; }
      delay = since < C.CHECK_FAST_FOR_MS ? C.CHECK_FAST_MS : C.CHECK_SLOW_MS;
    }
    checkTimer = setTimeout(function () { check(false); }, delay);
  }

  function stop() {
    stopped = true;
    clearTimeout(checkTimer);
    $('waitSpinner').className = 'spinner stopped';
    setStatus('We have not found your payment yet. Tap "Check now" to look again.', 'Payment not found yet — tap to see options');
    offerPending(true);
  }

  function visible() { return !document.visibilityState || document.visibilityState === 'visible'; }

  function offerPending(force) {
    var ready = S.alreadyPaid ? checks >= 1
      : (S.clickedAt && Date.now() - S.clickedAt >= C.PENDING_OFFER_AFTER_MS && checks >= 2);
    if (force || ready) $('pendingOffer').hidden = false;
  }

  function check(manual) {
    if (S.phase !== 'waiting' || checking || submitting) return;
    if (!visible() && !manual) return; // resumes when the page is shown again
    if (S.payCents !== totalCents()) {
      $('waitProblem').textContent = 'Your package selection changed after opening PayPal (€' + euro(S.payCents) +
        ' → €' + euro(totalCents()) + '). If you already paid €' + euro(S.payCents) +
        ', select the same packages again. Otherwise pay again with the new total.';
      $('payArea').hidden = false;
      $('payInfo').hidden = false;
      return;
    }
    $('payArea').hidden = true;
    $('payInfo').hidden = true;
    if (manual) { stopped = false; checkingSince = null; $('waitSpinner').className = 'spinner'; }
    if (!checkingSince) checkingSince = Date.now();
    checking = true;
    $('checkNowButton').disabled = true;
    setStatus('Checking your payment…');
    ensureSession().then(function () {
      return K.call('verifyPayment', formData, { retries: 2 });
    }).then(function (res) {
      checking = false;
      $('checkNowButton').disabled = false;
      checks++;
      if (res && res.registered) { finish(res.registered); return; }
      if (res && res.verified) { submit(false); return; }
      if (res && res.wrongAmount) {
        $('waitProblem').textContent = 'We found a PayPal payment of €' + res.wrongAmount + ' from you, but your total is €' +
          res.total + '. Only the exact amount can be accepted. Please do not pay again — email ' + C.HELP_EMAIL +
          ' with your name and we will sort it out.';
        stop();
        return;
      }
      $('waitProblem').textContent = '';
      var name = form.elements.firstName.value.trim() + ' ' + form.elements.lastName.value.trim();
      setStatus(S.alreadyPaid
        ? 'No payment of exactly €' + euro(S.payCents) + ' from "' + name + '" found yet. The name must be exactly as on your PayPal account.'
        : 'Not found yet — PayPal can take a minute. Checking again automatically…');
      offerPending(false);
      if (S.alreadyPaid && checks >= 3) { stop(); return; }
      schedule();
    }, function (error) {
      checking = false;
      $('checkNowButton').disabled = false;
      if (error && error.temporary) {
        setStatus('Connection problem — trying again…');
        schedule(C.CHECK_SLOW_MS);
        return;
      }
      $('waitProblem').textContent = error && error.message ? error.message : 'Could not check the payment.';
      setStatus('Please correct the problem above, then tap "Check now".');
      stopped = true;
      $('waitSpinner').className = 'spinner stopped';
    });
  }

  /* ---------------- submit ---------------- */

  function submit(allowPending) {
    if (submitting) return;
    if (!validate()) { S.phase = 'waiting'; render(); return; }
    submitting = true;
    clearTimeout(checkTimer);
    S.phase = 'submitting';
    saveState();
    render();
    setStatus(allowPending ? 'Saving your registration…' : 'Payment found! Saving your registration…');
    var data = function () { var d = formData(); d.allowPending = !!allowPending; return d; };
    K.call('saveRegistration', data, { retries: 6, timeoutMs: 90000 }).then(function (r) {
      submitting = false;
      finish(r);
    }, function (error) {
      submitting = false;
      if (error && error.temporary) { afterLostAnswer(); return; }
      S.phase = 'waiting';
      saveState();
      render();
      var text = error && error.message ? error.message : 'Could not save your registration.';
      if (/could not find your PayPal payment|still being checked/i.test(text)) {
        setStatus(text);
        schedule(C.CHECK_SLOW_MS);
        return;
      }
      $('waitProblem').textContent = text;
      stop();
    });
  }

  // The answer to "Submit" never arrived: was it saved? Then show it, else keep checking.
  function afterLostAnswer() {
    S.phase = 'submitting';
    saveState();
    render();
    setStatus('Checking whether your registration was saved…');
    K.call('findRegistration', { registrationKey: S.key }, { retries: 8 }).then(function (r) {
      if (r && r.found) { finish(r); return; }
      S.phase = 'waiting';
      saveState();
      render();
      check(true);
    }, function () {
      S.phase = 'waiting';
      saveState();
      render();
      setStatus('No connection to the server. Tap "Check now" when you are online again.');
      stopped = true;
    });
  }

  /* ---------------- done ---------------- */

  function finish(r) {
    clearTimeout(checkTimer);
    var ticket = {
      ticketId: r.ticketId,
      firstName: form.elements.firstName.value.trim(),
      packages: packagesFromForm(),
      guests: 0
    };
    ticket.guests = ticket.packages.reduce(function (s, p) { return s + p.quantity; }, 0);
    var email = r.email || form.elements.email.value.trim();
    var paid = r.paid === true || (r.pending !== true && r.success === true);
    S.phase = 'done';
    saveState();
    setUrlKey('');
    K.rememberTicket(ticket);
    showDone(ticket, paid, email, r);
    if (!ticket.packages.length) {
      // Restored from the server: the form may be empty, so get the ticket itself.
      K.call('getTicket', { ticketId: r.ticketId }, { retries: 3 }).then(function (t) {
        if (t && t.found) showDone(t, t.status === 'paid', email, r);
      }, function () { /* the ticket page link still works */ });
    }
  }

  function showDone(ticket, paid, email, r) {
    form.hidden = true;
    $('statusBar').hidden = true;
    var panel = $('donePanel');
    panel.hidden = false;
    var badge = $('doneBadge');
    var box = $('ticketBox');
    if (paid) {
      badge.textContent = '✔ REGISTRATION CONFIRMED';
      badge.className = 'done-badge';
      $('doneTitle').textContent = 'Thank you' + (ticket.firstName ? ', ' + ticket.firstName : '') + '!';
      $('doneText').textContent = 'Your payment' + (r.total ? ' of €' + r.total : '') + ' is confirmed. ' +
        (r.emailSent === false
          ? 'Your QR ticket will also be emailed to ' + email + ' shortly.'
          : 'Your QR ticket has also been emailed to ' + email + ' (please check Spam / Promotions).') +
        ' Save it on your phone now:';
      K.renderTicket(box, ticket);
    } else {
      badge.textContent = 'REGISTRATION RECEIVED';
      badge.className = 'done-badge pending';
      $('doneTitle').textContent = 'We are checking your payment';
      $('doneText').textContent = 'Your reference is ' + ticket.ticketId + '. The organisers will confirm your PayPal payment and email your QR ticket to ' +
        email + '. Your ticket page shows the QR code as soon as the payment is confirmed — keep the link:';
      box.innerHTML = '';
      var a = K.el('a', { href: K.ticketUrl(ticket.ticketId), 'class': 'ticket-link', id: 'ticketPageLink' }, 'Open my ticket page');
      box.appendChild(K.el('p', { 'class': 'ticket-id' }, ticket.ticketId));
      box.appendChild(a);
    }
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function another() {
    S = { key: null, phase: 'form', payCents: null, clickedAt: null, sessionId: null, beaconSent: false, alreadyPaid: false };
    resetChecks();
    form.reset();
    K.store.remove(STATE_KEY);
    setUrlKey('');
    $('donePanel').hidden = true;
    form.hidden = false;
    showMessage('');
    updateTotal();
    updateEmailMatch();
    render();
    showMyTickets();
    window.scrollTo(0, 0);
  }

  /* ---------------- page state ---------------- */

  function updateTotal() {
    var cents = totalCents();
    $('total').textContent = euro(cents);
    $('payAmount').textContent = euro(cents);
    setText('.rule-amount', cents > 0 ? euroLocal(cents) + ' € (' + amountInWords(cents) + ')' : 'the total shown on the button');
  }

  function render() {
    var waiting = S.phase === 'waiting' || S.phase === 'submitting';
    var paying = waiting && S.payCents === totalCents();
    $('payArea').hidden = paying;
    $('payInfo').hidden = paying;
    $('waitPanel').hidden = !waiting;
    updateBar();
    $('payButton').classList.toggle('locked', !rules.checked);
    if (waiting) {
      var c = S.payCents || 0;
      setText('.wait-amount', euro(c));
      setText('.wait-amount-local', euroLocal(c));
      setText('.wait-amount-words', amountInWords(c));
      $('waitTitle').firstChild.textContent = S.alreadyPaid ? 'Looking for your PayPal payment of €' : 'Waiting for your PayPal payment of €';
      $('changeOrderButton').textContent = S.alreadyPaid ? 'Back to the form' : 'Change my order (I have not paid yet)';
      $('checkNowButton').disabled = S.phase === 'submitting';
      $('pendingButton').disabled = S.phase === 'submitting';
      $('payAgainLink').hidden = S.alreadyPaid;
    }
  }

  function showMyTickets() {
    var list = K.myTickets();
    var old = $('myTickets');
    if (old) old.parentNode.removeChild(old);
    if (!list.length) return;
    var box = K.el('div', { id: 'myTickets', 'class': 'notice my-tickets' });
    box.appendChild(K.el('strong', null, 'Already registered on this phone:'));
    list.slice(0, 3).forEach(function (t) {
      var p = K.el('p');
      p.appendChild(K.el('a', { href: K.ticketUrl(t.ticketId) }, 'View ticket ' + t.ticketId + (t.firstName ? ' (' + t.firstName + ')' : '')));
      box.appendChild(p);
    });
    form.parentNode.insertBefore(box, form);
  }

  function wake() {
    if (S.phase === 'waiting' && visible()) {
      if (stopped) return;
      clearTimeout(checkTimer);
      checkTimer = setTimeout(function () { check(false); }, 400);
    }
  }

  /* ---------------- events ---------------- */

  QTY.forEach(function (n) {
    form.elements[n].addEventListener('change', function () {
      updateTotal();
      if (S.phase === 'waiting') {
        if (S.payCents === totalCents()) { $('waitProblem').textContent = ''; render(); wake(); }
        else check(true);
      }
    });
  });
  form.elements.email.addEventListener('input', updateEmailMatch);
  form.elements.emailConfirm.addEventListener('input', updateEmailMatch);
  form.addEventListener('input', saveState);
  form.addEventListener('change', saveState);
  rules.addEventListener('change', render);
  form.addEventListener('submit', function (e) { e.preventDefault(); });

  $('payButton').addEventListener('click', function () { pay(false); });
  $('payWebLink').addEventListener('click', function (e) { e.preventDefault(); pay(true); });
  $('payAgainLink').addEventListener('click', function (e) { e.preventDefault(); pay(false); });
  $('alreadyPaidButton').addEventListener('click', alreadyPaid);
  $('checkNowButton').addEventListener('click', function () { check(true); });
  $('pendingButton').addEventListener('click', function () {
    if (!window.confirm('Submit without an automatic payment match? Only do this if you really paid €' + euro(S.payCents) + '. The organisers will check it.')) return;
    submit(true);
  });
  $('changeOrderButton').addEventListener('click', backToForm);
  $('anotherButton').addEventListener('click', another);
  $('statusBar').addEventListener('click', function () { $('waitPanel').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('copyUser').addEventListener('click', function () { K.copyText(C.PAYPAL_ME_USERNAME, this); });
  $('copyAmount').addEventListener('click', function () { K.copyText(euroLocal(S.payCents || totalCents()), this); });

  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', wake);
  window.addEventListener('online', function () { stopped = false; wake(); });
  window.addEventListener('pageshow', function (e) {
    // Page shown again from the browser's memory (Back button): calls that were
    // cut off when the page was left never finish, so start fresh.
    if (e.persisted) { checking = false; sessionPromise = null; if (S.phase === 'submitting') afterLostAnswer(); else wake(); }
  });

  setText('.pp-user', C.PAYPAL_ME_USERNAME);
  setText('.pp-name', C.PAYPAL_DISPLAY_NAME);

  /* ---------------- start ---------------- */

  function resumeFrom(st) {
    fillFields(st.fields);
    rules.checked = !!st.rules;
    S.key = st.key || null;
    S.phase = st.phase === 'submitting' || st.phase === 'waiting' ? st.phase : 'form';
    S.payCents = st.payCents || null;
    S.clickedAt = st.clickedAt || null;
    S.sessionId = st.sessionId || null;
    S.beaconSent = !!st.beaconSent;
    S.alreadyPaid = !!st.alreadyPaid;
    if (S.phase !== 'form' && !S.payCents) S.phase = 'form';
  }

  function begin() {
    updateTotal();
    updateEmailMatch();
    render();
    if (S.phase === 'waiting' || S.phase === 'submitting') {
      setUrlKey(S.key);
      $('paymentSection').scrollIntoView({ block: 'start' });
      if (S.phase === 'submitting') { afterLostAnswer(); return; }
      setStatus('Welcome back! Checking your payment…');
      check(false);
      if (!visible()) setStatus('Pay on PayPal, then come back to this page. We check for your payment automatically.');
    }
  }

  showMyTickets();
  var urlKey = param('r');
  var saved = loadState();
  if (saved && (!urlKey || saved.key === urlKey)) {
    resumeFrom(saved);
    begin();
  } else if (/^[A-Za-z0-9-]{16,64}$/.test(urlKey)) {
    // Opened with ?r=... but nothing saved in this browser: ask the server.
    S.key = urlKey;
    showMessage('Restoring your registration…', '');
    K.call('resumePayment', { registrationKey: urlKey }, { retries: 4 }).then(function (res) {
      showMessage('');
      if (res && res.registered) { finish(res.registered); return; }
      if (!res || !res.found) { S.key = null; setUrlKey(''); begin(); return; }
      fillFields(res.fields || {});
      rules.checked = true;
      S.phase = 'waiting';
      S.payCents = totalCents();
      S.clickedAt = res.clickedAt || null;
      S.sessionId = res.paymentSessionId || null;
      saveState();
      begin();
    }, function () {
      showMessage('Could not restore your registration (no connection). If you already paid, fill in the form and tap "I have already paid".', 'error');
      S.key = null;
      setUrlKey('');
      begin();
    });
  } else {
    if (urlKey) setUrlKey('');
    begin();
  }
})();
