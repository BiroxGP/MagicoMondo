// Inoltra i tiri di dadi al canale Discord del gruppo.
// Il webhook sta nella variabile d'ambiente DISCORD_WEBHOOK_URL (Vercel), mai nel codice.

const MAX_PER_WINDOW = 20;
const WINDOW_MS = 60_000;
const hits = new Map();

function tooMany(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) {
    for (const [key, times] of hits) {
      if (!times.some((t) => now - t < WINDOW_MS)) hits.delete(key);
    }
  }
  return recent.length > MAX_PER_WINDOW;
}

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const hook = process.env.DISCORD_WEBHOOK_URL;
  if (!hook) return res.status(503).json({ error: 'not_configured' });

  const origin = req.headers.origin;
  if (origin) {
    let sameSite = false;
    try {
      sameSite = new URL(origin).host === req.headers.host;
    } catch {
      sameSite = false;
    }
    if (!sameSite) return res.status(403).json({ error: 'forbidden_origin' });
  }

  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (tooMany(forwarded || 'unknown')) return res.status(429).json({ error: 'rate_limited' });

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'bad_request' });

  // Accetta solo messaggi di tiro (iniziano sempre con il dado) e ricostruisce il payload
  // campo per campo: niente menzioni, niente link o allegati arbitrari.
  const content = text(body.content, 1800);
  if (!content.includes('🎲')) return res.status(400).json({ error: 'not_a_roll' });

  const payload = {
    username: text(body.username, 80) || 'Giocatore',
    content,
    allowed_mentions: { parse: [] },
  };

  const embed = Array.isArray(body.embeds) ? body.embeds[0] : null;
  if (embed && typeof embed === 'object') {
    const fields = Array.isArray(embed.fields) ? embed.fields.slice(0, 10) : [];
    payload.embeds = [
      {
        color: Number.isInteger(embed.color) ? embed.color : 0,
        description: text(embed.description, 300) || undefined,
        fields: fields
          .map((f) => ({
            name: text(f && f.name, 100),
            value: text(f && f.value, 200) || '-',
            inline: !!(f && f.inline),
          }))
          .filter((f) => f.name),
      },
    ];
  }

  try {
    const r = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return res.status(502).json({ error: 'discord_error', status: r.status });
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(502).json({ error: 'discord_unreachable' });
  }
}
