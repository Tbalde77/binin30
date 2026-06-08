// api/generate-quote.js
// Secure Vercel serverless function
// Anthropic key NEVER leaves server

const RATE_LIMIT = new Map(); // simple in-memory rate limiter

export default async function handler(req, res) {
  // CORS — only allow our domain
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://www.binin30.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limiting (per IP)
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxPerMinute = 10;

  const hits = RATE_LIMIT.get(ip) || [];
  const recent = hits.filter(t => now - t < windowMs);
  if (recent.length >= maxPerMinute) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }
  RATE_LIMIT.set(ip, [...recent, now]);

  // API key check
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Parse and validate body
  const { serviceType, description, timeline, urgency, isPro } = req.body || {};

  if (!description || typeof description !== 'string' || description.trim().length < 5) {
    return res.status(400).json({ error: 'Please provide a project description.' });
  }
  if (description.length > 2000) {
    return res.status(400).json({ error: 'Description too long. Max 2000 characters.' });
  }

  // Validate session for pro features (optional — frontend also checks)
  let userIsPro = false;
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ') && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const token = authHeader.slice(7);
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) {
        const { data: sub } = await supabase.from('subscriptions').select('plan').eq('user_id', user.id).eq('status', 'active').single();
        userIsPro = sub?.plan === 'pro' || sub?.plan === 'business';
      }
    } catch (e) {
      // Continue without pro features if token validation fails
    }
  }

  const surcharge = urgency === 'urgent' ? ' Apply 25% urgency surcharge to all labor items.'
    : urgency === 'emergency' ? ' Apply 50% emergency surcharge to all labor items.' : '';

  // Build prompt — pro users get risk advisor
  const proSection = (isPro || userIsPro) ? `

Also return a "risk" object and "fieldNotes" array:
- risk.forgotten: array of commonly forgotten parts for this job type
- risk.related: array of associated parts that often need replacement together  
- risk.delays: array of long lead-time items (compressors, coils, panels, etc.)
- risk.permits: array of permit or inspection considerations
- fieldNotes: array of 4-6 professional field notes for the technician

` : '';

  const prompt = `You are an expert cost estimator for independent contractors in North Carolina (RTP/Cary/Durham/Apex).

Generate a realistic, detailed quote for:
- Service type: ${serviceType || 'General'}
- Description: ${description.trim()}
- Timeline: ${timeline || '1-3 days'}
- Urgency: ${urgency || 'standard'}${surcharge}
${proSection}
Return ONLY valid JSON, no markdown, no backticks:
{
  "items": [{"desc":"...","qty":1,"up":150}],
  "note": "One professional sentence for the client."${(isPro || userIsPro) ? `,
  "risk": {
    "forgotten": ["..."],
    "related": ["..."],
    "delays": ["..."],
    "permits": ["..."]
  },
  "fieldNotes": ["...","...","..."]` : ''}
}

Use realistic 2026 Raleigh-Durham NC market rates. Separate labor and materials clearly. Be specific.`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: (isPro || userIsPro) ? 2000 : 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error('Anthropic error:', errBody);
      return res.status(502).json({ error: 'AI service error. Please try again.' });
    }

    const anthropicData = await anthropicRes.json();
    const raw = anthropicData.content?.map(b => b.text || '').join('') || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { return res.status(502).json({ error: 'Invalid AI response. Please try again.' }); }

    if (!parsed.items?.length) {
      return res.status(502).json({ error: 'No items returned. Please try again.' });
    }

    // Sanitize output
    const response = {
      items: parsed.items.map(it => ({
        desc: String(it.desc || '').slice(0, 200),
        qty: Math.max(0, parseFloat(it.qty) || 1),
        up: Math.max(0, parseFloat(it.up) || 0),
      })),
      note: String(parsed.note || '').slice(0, 400),
    };

    // Add pro data if available
    if ((isPro || userIsPro) && parsed.risk) {
      response.risk = {
        forgotten: (parsed.risk.forgotten || []).slice(0, 10).map(s => String(s).slice(0, 80)),
        related: (parsed.risk.related || []).slice(0, 10).map(s => String(s).slice(0, 80)),
        delays: (parsed.risk.delays || []).slice(0, 8).map(s => String(s).slice(0, 80)),
        permits: (parsed.risk.permits || []).slice(0, 6).map(s => String(s).slice(0, 120)),
      };
      response.fieldNotes = (parsed.fieldNotes || []).slice(0, 8).map(s => String(s).slice(0, 200));
    }

    return res.status(200).json(response);

  } catch (err) {
    console.error('generate-quote error:', err);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
}
