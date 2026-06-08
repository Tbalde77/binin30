// api/generate-quote.js
// Secure Vercel serverless function
// Anthropic API key NEVER leaves the server
// Full debug logging included

const RATE_LIMIT = new Map();

export default async function handler(req, res) {
  const requestId = Date.now().toString(36).toUpperCase();
  console.log(`[${requestId}] ===== GENERATE-QUOTE START =====`);
  console.log(`[${requestId}] Method: ${req.method}`);
  console.log(`[${requestId}] URL: ${req.url}`);

  // CORS headers
  const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://www.binin30.com';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    console.log(`[${requestId}] OPTIONS preflight — returning 200`);
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    console.log(`[${requestId}] Wrong method: ${req.method}`);
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // Rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const hits = (RATE_LIMIT.get(ip) || []).filter(t => now - t < 60000);
  if (hits.length >= 15) {
    console.log(`[${requestId}] Rate limit hit for IP: ${ip}`);
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }
  RATE_LIMIT.set(ip, [...hits, now]);

  // Check Anthropic API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log(`[${requestId}] ANTHROPIC_API_KEY present: ${!!apiKey}`);
  console.log(`[${requestId}] ANTHROPIC_API_KEY length: ${apiKey ? apiKey.length : 0}`);
  console.log(`[${requestId}] ANTHROPIC_API_KEY prefix: ${apiKey ? apiKey.slice(0, 12) + '...' : 'MISSING'}`);

  if (!apiKey) {
    console.error(`[${requestId}] FATAL: ANTHROPIC_API_KEY not set in environment`);
    return res.status(500).json({
      error: 'Server configuration error: ANTHROPIC_API_KEY missing.',
      debug: 'Add ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables'
    });
  }

  // Parse request body
  const body = req.body || {};
  console.log(`[${requestId}] Request body:`, JSON.stringify(body));

  const { serviceType, description, timeline, urgency, isPro } = body;

  if (!description || typeof description !== 'string' || description.trim().length < 5) {
    console.log(`[${requestId}] Invalid description: "${description}"`);
    return res.status(400).json({ error: 'Please provide a project description (min 5 characters).' });
  }

  if (description.length > 2000) {
    return res.status(400).json({ error: 'Description too long. Max 2000 characters.' });
  }

  // Validate pro token (optional)
  let userIsPro = false;
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ') && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { data: { user } } = await sb.auth.getUser(authHeader.slice(7));
      if (user) {
        const { data: sub } = await sb.from('subscriptions').select('plan').eq('user_id', user.id).eq('status', 'active').maybeSingle();
        userIsPro = ['pro', 'business'].includes(sub?.plan);
        console.log(`[${requestId}] User: ${user.id}, Plan: ${sub?.plan}, isPro: ${userIsPro}`);
      }
    } catch (e) {
      console.warn(`[${requestId}] Auth validation warning (non-fatal):`, e.message);
    }
  }

  const proUser = isPro || userIsPro;
  console.log(`[${requestId}] proUser: ${proUser}`);

  const surcharge = urgency === 'urgent'
    ? ' Apply a 25% urgency surcharge to all labor items.'
    : urgency === 'emergency'
    ? ' Apply a 50% emergency surcharge to all labor items.'
    : '';

  const proSection = proUser ? `
Also include in your JSON response:
- "profit": { "estimatedCost": number, "suggestedPrice": number, "grossProfit": number, "marginPct": number }
- "risk": { "forgotten": ["..."], "related": ["..."], "delays": ["..."], "permits": ["..."] }
- "fieldNotes": ["note1", "note2", "note3", "note4", "note5"]
` : '';

  const prompt = `You are an expert cost estimator for independent contractors in North Carolina (RTP, Cary, Durham, Apex area).

Generate a detailed, realistic, itemized quote for this project:
- Service type: ${serviceType || 'General'}
- Project description: ${description.trim()}
- Timeline: ${timeline || '1-3 days'}
- Urgency: ${urgency || 'standard'}${surcharge}
${proSection}
You MUST return ONLY valid JSON. No markdown. No backticks. No explanation. Just the JSON object.

Required format:
{
  "items": [
    { "desc": "AC Compressor Replacement - Labor", "qty": 1, "up": 850 },
    { "desc": "Copeland 3.5-ton Scroll Compressor", "qty": 1, "up": 1200 },
    { "desc": "R-410A Refrigerant (5 lbs)", "qty": 5, "up": 45 },
    { "desc": "Filter Drier", "qty": 1, "up": 35 }
  ],
  "note": "One concise professional note for the client about this job."${proUser ? `,
  "profit": { "estimatedCost": 1800, "suggestedPrice": 2600, "grossProfit": 800, "marginPct": 31 },
  "risk": {
    "forgotten": ["Capacitor", "Contactor", "Disconnect fuse"],
    "related": ["Fan motor", "Condenser coil inspection"],
    "delays": ["Compressor (3-7 days lead time if OEM)"],
    "permits": ["Mechanical permit may be required for compressor replacement"]
  },
  "fieldNotes": [
    "Verify model and serial numbers before ordering compressor.",
    "Check capacitor and contactor — replace if showing wear.",
    "Inspect refrigerant lines for signs of leaks or oil fouling.",
    "Confirm unit electrical disconnect is properly rated.",
    "Advise customer on potential coil cleaning if efficiency is low."
  ]` : ''}
}

Use realistic 2026 Raleigh-Durham NC contractor market pricing. Always separate labor and materials as distinct line items.`;

  console.log(`[${requestId}] Calling Anthropic API...`);
  console.log(`[${requestId}] Model: claude-sonnet-4-5`);
  console.log(`[${requestId}] Max tokens: ${proUser ? 2000 : 1200}`);

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: proUser ? 2000 : 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    console.log(`[${requestId}] Anthropic HTTP status: ${anthropicRes.status}`);

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error(`[${requestId}] Anthropic error response:`, errBody);
      return res.status(502).json({
        error: 'AI service returned an error. Please try again.',
        debug: `Anthropic status: ${anthropicRes.status}`
      });
    }

    const anthropicData = await anthropicRes.json();
    console.log(`[${requestId}] Anthropic response received`);
    console.log(`[${requestId}] Content blocks: ${anthropicData.content?.length}`);
    console.log(`[${requestId}] Stop reason: ${anthropicData.stop_reason}`);
    console.log(`[${requestId}] Usage:`, JSON.stringify(anthropicData.usage));

    const rawText = anthropicData.content?.map(b => b.text || '').join('') || '';
    console.log(`[${requestId}] Raw text length: ${rawText.length}`);
    console.log(`[${requestId}] Raw text preview: ${rawText.slice(0, 200)}`);

    // Clean and parse JSON
    const cleaned = rawText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    console.log(`[${requestId}] Cleaned JSON preview: ${cleaned.slice(0, 200)}`);

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error(`[${requestId}] JSON parse error:`, parseErr.message);
      console.error(`[${requestId}] Failed to parse:`, cleaned.slice(0, 500));
      return res.status(502).json({
        error: 'AI returned invalid format. Please try again.',
        debug: `Parse error: ${parseErr.message}`
      });
    }

    console.log(`[${requestId}] Parsed items count: ${parsed.items?.length}`);

    if (!parsed.items || !Array.isArray(parsed.items) || parsed.items.length === 0) {
      console.error(`[${requestId}] No items in parsed response:`, JSON.stringify(parsed).slice(0, 300));
      return res.status(502).json({
        error: 'AI returned no line items. Please try again.',
        debug: 'parsed.items is empty or missing'
      });
    }

    // Build sanitized response
    const items = parsed.items.map(it => ({
      desc: String(it.desc || '').slice(0, 200),
      qty: Math.max(0.01, parseFloat(it.qty) || 1),
      up: Math.max(0, parseFloat(it.up) || 0),
    }));

    const subtotal = items.reduce((s, i) => s + i.qty * i.up, 0);
    const tax = subtotal * 0.0725;
    const total = subtotal + tax;

    const response = {
      items,
      note: String(parsed.note || '').slice(0, 400),
      subtotal: Math.round(subtotal * 100) / 100,
      tax: Math.round(tax * 100) / 100,
      total: Math.round(total * 100) / 100,
    };

    if (proUser) {
      if (parsed.profit) {
        response.profit = {
          estimatedCost: parseFloat(parsed.profit.estimatedCost) || 0,
          suggestedPrice: parseFloat(parsed.profit.suggestedPrice) || 0,
          grossProfit: parseFloat(parsed.profit.grossProfit) || 0,
          marginPct: parseFloat(parsed.profit.marginPct) || 0,
        };
      }
      if (parsed.risk) {
        response.risk = {
          forgotten: (parsed.risk.forgotten || []).slice(0, 10).map(s => String(s).slice(0, 80)),
          related: (parsed.risk.related || []).slice(0, 10).map(s => String(s).slice(0, 80)),
          delays: (parsed.risk.delays || []).slice(0, 8).map(s => String(s).slice(0, 100)),
          permits: (parsed.risk.permits || []).slice(0, 6).map(s => String(s).slice(0, 150)),
        };
      }
      if (parsed.fieldNotes) {
        response.fieldNotes = (parsed.fieldNotes || []).slice(0, 6).map(s => String(s).slice(0, 200));
      }
    }

    console.log(`[${requestId}] SUCCESS — returning ${items.length} items, total: $${total.toFixed(2)}`);
    console.log(`[${requestId}] ===== GENERATE-QUOTE END =====`);

    return res.status(200).json(response);

  } catch (err) {
    console.error(`[${requestId}] UNEXPECTED ERROR:`, err.message);
    console.error(`[${requestId}] Stack:`, err.stack);
    return res.status(500).json({
      error: 'Internal server error. Please try again.',
      debug: err.message
    });
  }
}
