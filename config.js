/*
 * SETTINGS for the website. Change these, then upload the file again.
 *
 * API_URL: your Apps Script web app address (Deploy -> Manage deployments ->
 *   Web app URL, ends in /exec). After changing Code.gs, edit the SAME
 *   deployment and choose "New version" so this address stays the same.
 * PAYPAL_ME_USERNAME: the PayPal.Me name that receives the payments.
 * Prices are in register.html (data-price) and must match PACKAGE_PRICES in Code.gs.
 */
window.KAHALE_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbwK0nXzOyodNVZhx4LvJLStHNdJyMtpJ0dClUcq1ZS8Kq6ad8zhLSk9E2BJULVrJEOH/exec',
  PAYPAL_ME_USERNAME: 'Abhay2309',
  PAYPAL_DISPLAY_NAME: 'Abhay Sathyanarayana Rao',
  HELP_NAME: 'Abhay',
  HELP_EMAIL: 'kahalekarnataka1973@gmail.com',
  EVENT_TITLE: 'KĀHALE · Kannada Rajyotsava 2026',
  EVENT_DATE: '15 November 2026 · 14:00',
  EVENT_VENUE: 'Transit Club, Reichenhainer Str. 1, 09111 Chemnitz',

  // Payment check timing (milliseconds). Normally leave as they are.
  CHECK_FAST_MS: 6000,          // first minutes: check every 6 s
  CHECK_SLOW_MS: 15000,         // later: every 15 s
  CHECK_FAST_FOR_MS: 180000,    // fast checks for 3 minutes
  CHECK_STOP_AFTER_MS: 1200000, // stop automatic checks after 20 minutes ("Check again" button)
  PENDING_OFFER_AFTER_MS: 180000 // offer "organisers will check my payment" after 3 minutes
};
