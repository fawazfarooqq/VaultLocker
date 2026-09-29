// Frontend configuration — the ONLY place these values live.
// The publishable key is public by design (RLS protects the data). Never put SUPABASE_SECRET_KEY here.
window.VAULTLOCK_CONFIG = {
  SUPABASE_URL: "https://btnjovmlvibhmdvozysp.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_Xx77w1NYsgt6_xXyFJrsvw_K-Rf78rk", // Supabase → Project Settings → API Keys → Publishable key
  API_URL: "http://localhost:5000",
  // Must match Supabase → Authentication → URL Configuration → Redirect URLs exactly.
  REDIRECT_URL: "http://localhost:5500/frontend/index.html",
};
