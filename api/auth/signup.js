// api/auth/signup.js
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password, businessName } = req.body || {};
  if (!email || !password || !businessName) return res.status(400).json({ error: 'All fields required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });

  // Create business profile
  await supabaseAdmin.from('business_profiles').insert({
    user_id: data.user.id,
    business_name: businessName,
    created_at: new Date().toISOString(),
  });

  // Create free usage record
  await supabaseAdmin.from('usage_limits').insert({
    user_id: data.user.id,
    quotes_used: 0,
    month: new Date().toISOString().slice(0, 7),
  });

  return res.status(200).json({
    token: data.session?.access_token || null,
    email: data.user.email,
    userId: data.user.id,
    plan: 'free',
    profile: { business_name: businessName },
  });
}
