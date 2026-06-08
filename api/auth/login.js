// api/auth/login.js
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });

  // Get subscription plan
  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: sub } = await supabaseAdmin.from('subscriptions').select('plan').eq('user_id', data.user.id).eq('status', 'active').maybeSingle();
  const { data: profile } = await supabaseAdmin.from('business_profiles').select('*').eq('user_id', data.user.id).maybeSingle();

  return res.status(200).json({
    token: data.session.access_token,
    email: data.user.email,
    userId: data.user.id,
    plan: sub?.plan || 'free',
    profile: profile || null,
  });
}
