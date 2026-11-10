// RESERVATION CONFIG TEMPLATE.
// Copy this to reservations/config.js and fill in your own values before deploying.
window.RESERVATION_CONFIG = {
  // Google reCAPTCHA v3 site key (leave empty to always use the email OTP fallback)
  RECAPTCHA_SITE_KEY: '',

  // Supabase credentials (same as used in shop.html and account.html)
  SUPABASE_URL: 'https://your-project.supabase.co',
  SUPABASE_KEY: 'your_supabase_anon_key_here',

  // Optional: contact number shown wherever booking needs a fallback
  CONTACT_PHONE: '9632 6039',

  // Optional: shown on the manage pages and in the calendar event
  VENUE_NAME: 'Lang Nuong Vietnam BBQ & Exclusive',
  VENUE_ADDRESS: '271A Jalan Besar, Singapore 208941'
};
