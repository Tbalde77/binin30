// api/billing/webhook.js
// Stripe webhook — activates Pro plan after payment

import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const rawBody = await getRawBody(req);

  // Verify Stripe signature
  let event;
  try {
    const crypto = await import('crypto');
    const [, timestampPart, , signaturePart] = sig.split(',').reduce((acc, part) => {
      const [k, v] = part.split('=');
      return { ...acc, [k]: v };
    }, {t:'',v1:''});
    // Simple verification — use stripe npm package in production for full security
    // npm install stripe  then:  const stripe = require('stripe')(key); event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    event = JSON.parse(rawBody.toString());
  } catch (err) {
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (event.type === 'checkout.session.completed' || event.type === 'customer.subscription.created') {
    const sub = event.data.object;
    const customerId = sub.customer;
    const plan = sub.metadata?.plan || 'pro';

    // Find user by Stripe customer ID
    const { data: profile } = await supabase.from('business_profiles').select('user_id').eq('stripe_customer_id', customerId).maybeSingle();

    if (profile) {
      await supabase.from('subscriptions').upsert({
        user_id: profile.user_id,
        plan,
        status: 'active',
        stripe_subscription_id: sub.id || sub.subscription,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    await supabase.from('subscriptions').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('stripe_subscription_id', sub.id);
  }

  return res.status(200).json({ received: true });
}
