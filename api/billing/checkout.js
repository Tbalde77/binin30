// api/billing/checkout.js
// Creates a Stripe Checkout session for Pro or Business plan

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const plan = req.query.plan || 'pro';
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Billing not configured' });

  const PRICES = {
    pro: process.env.STRIPE_PRICE_PRO,         // $29/mo
    business: process.env.STRIPE_PRICE_BUSINESS, // $49/mo
  };

  const priceId = PRICES[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + stripeKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'mode': 'subscription',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'success_url': (process.env.ALLOWED_ORIGIN || 'https://www.binin30.com') + '?upgrade=success',
        'cancel_url': (process.env.ALLOWED_ORIGIN || 'https://www.binin30.com') + '?upgrade=cancel',
        'allow_promotion_codes': 'true',
      }),
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) throw new Error(session.error?.message || 'Stripe error');

    return res.redirect(303, session.url);
  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: 'Could not create checkout session.' });
  }
}
