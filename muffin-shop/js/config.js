// ===== Backend (SM REV) =====
// Always point to the SM-REV deployment (absolute URL).

// ===== Stripe (client) =====
window.STRIPE_PUBLISHABLE_KEY = 'pk_live_51S4aBEREXhAlHXGEibCVEAXiXtB3B3iGPVxZRS9Bjfxvq7x1qwOy54qWYLEHfiw5L1yNWjjzDQqN1WL4bXTBQ0Vh00u5L2bckP';
window.SMREV_API_BASE = 'https://sm-rev.vercel.app/api';

// Optional: allow overriding for previews/local testing via ?apiBase=https://... or localStorage("smrev_api_base")
// Only accept absolute http(s) URLs so we don't accidentally fall back to "/api".
(() => {
  try {
    const qs = new URLSearchParams(location.search);
    const param = qs.get('apiBase');
    if (param && /^https?:\/\//i.test(param)) localStorage.setItem('smrev_api_base', param);
    const saved = localStorage.getItem('smrev_api_base');
    if (saved && /^https?:\/\//i.test(saved)) window.SMREV_API_BASE = saved;
    console.debug('[SMREV] API base =', window.SMREV_API_BASE);
  } catch {}
})();
