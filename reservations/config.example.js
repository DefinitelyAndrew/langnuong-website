// Template for reservations/config.js. Only PUBLIC values belong here, because every
// value in this file is served to the browser. Never put secrets (reCAPTCHA secret
// key, SMTP passwords, Supabase service_role key) in this file.
window.RESERVATION_CONFIG = {
  // Google reCAPTCHA v3 SITE key (public; leave empty to always use the email OTP fallback)
  RECAPTCHA_SITE_KEY: '',
  
  // Supabase credentials (same as used in shop.html and account.html)
  SUPABASE_URL: 'https://egggnxmzxbqdsqqlnvig.supabase.co',
  SUPABASE_KEY: 'your_supabase_anon_key_here',
  
  // Optional: contact number shown wherever booking needs a fallback
  CONTACT_PHONE: '9632 6039',

  // Optional: shown on the manage pages and in the calendar event
  VENUE_NAME: 'Lang Nuong Vietnam',
  VENUE_ADDRESS: '271 Jalan Besar, Singapore'
};
