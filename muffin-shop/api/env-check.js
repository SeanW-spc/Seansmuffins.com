// api/env-check.js
// Returns presence (not values) of the env needed for Stripe + Airtable.
// Open in a browser: /api/env-check

export default async function handler(req, res) {
  const out = {
    stripe: {
      STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: !!process.env.STRIPE_WEBHOOK_SECRET,
    },
    site: {
      NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL || '(not set)',
    },
    airtable: {
      AIRTABLE_API_KEY: !!process.env.AIRTABLE_API_KEY,
      AIRTABLE_BASE_ID: !!process.env.AIRTABLE_BASE_ID,
      AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || '(not set)',
      AIRTABLE_TABLE_SLOTS: process.env.AIRTABLE_TABLE_SLOTS || '(not set)',
    },
    extra: {
      SLOT_CAPACITY_DEFAULT: process.env.SLOT_CAPACITY_DEFAULT || '(not set)',
    }
  };
  res.status(200).json(out);
}
