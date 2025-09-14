// js/config.js

// ===== Stripe (client) =====
window.STRIPE_PUBLISHABLE_KEY = 'pk_test_51S4aBLEhhuIMCnYGXZxOXmi9Q1wyFN1Zk5wXGrP8Aac43QuO5EqCkGYCwJBY9xy0abjA2uzR9tqjMIe3kKJtANy600kYjxMC90'; // your test publishable key

// IMPORTANT: use Stripe PRICE IDs (price_...), not prod_...
window.PRODUCT_PRICE_MAP = {
  BLUEBERRY: 'price_1S4xdNEhhuIMCnYG0n9xh6LQ',
  VANILLA:   'price_1S4xbBEhhuIMCnYGTGHNfZhh',
  CHOCOLATE: 'price_1S4xZcEhhuIMCnYGcoPap88e',
  BANANA:    'price_1S4xXgEhhuIMCnYGYLabD3Yp',
  PUMPKIN:   'price_1S4xW1EhhuIMCnYGqo4e87MS',
  SUBSCRIPTION: 'price_1S4xTIEhhuIMCnYGJkLqyqCj'
};

// ===== Backend (SM REV) =====
// Where the storefront calls the backend (SM REV). Replace the placeholder domain with your deployed SM REV URL.
window.SMREV_API_BASE = window.SMREV_API_BASE || 'https://sm-rev.vercel.app/api';

// Optional: allow easy overriding for previews/local testing via ?apiBase=... or localStorage("smrev_api_base")
(() => {
  try {
    const qs = new URLSearchParams(location.search);
    const param = qs.get('apiBase');
    if (param) localStorage.setItem('smrev_api_base', param);
    const saved = localStorage.getItem('smrev_api_base');
    if (saved) window.SMREV_API_BASE = saved;
  } catch (_) {
    // no-op if storage disabled
  }
})();
