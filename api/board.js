// Lavagna condivisa: la vedono tutti, la modifica solo il master (password GM_PASSWORD).
//  - lo stato della lavagna attiva sta in una sola chiave (mm:board_public): chi guarda
//    la legge con 1 comando e la risposta resta in cache sulla rete di Vercel per 2 secondi,
//    quindi il numero di spettatori non fa salire il consumo del database
//  - la mappa (immagine ridotta dal browser) è separata e si scarica una volta sola
//  - un solo master alla volta: un nuovo accesso master prende il controllo e il vecchio passa in sola lettura
import crypto from 'node:crypto';
import { hGetAll, hGet, hSet, hDel, kGet, kSet, storeKind } from './_store.js';

const BOARDS = 'mm:boards';
const IMGS = 'mm:board_imgs';
const PUBLIC = 'mm:board_public';
const LOCK = 'mm:board_lock';
const MAX_BOARDS = 10;
const MAX_IMG_CHARS = 3_400_000;
const MAX_STATE_CHARS = 600_000;
const JPEG_PREFIX = 'data:image/jpeg;base64,';
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const ID_RE = /^[A-Za-z0-9_-]{4,60}$/;

const hits = new Map();
const fails = new Map();

function limited(map, key, max, windowMs) {
  const now = Date.now();
  const recent = (map.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  map.set(key, recent);
  if (map.size > 500) {
    for (const [k, times] of map) {
      if (!times.some((t) => now - t < windowMs)) map.delete(k);
    }
  }
  return recent.length > max;
}

const num = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

const DEFAULT_GRID = { show: true, size: 50, ox: 0, oy: 0, color: '#000000', opacity: 0.35, scale: 1.5, unit: 'm', snap: true };

function cleanGrid(g) {
  const src = g && typeof g === 'object' ? g : {};
  return {
    show: src.show !== false,
    size: num(src.size, 10, 400, DEFAULT_GRID.size),
    ox: num(src.ox, -400, 400, 0),
    oy: num(src.oy, -400, 400, 0),
    color: COLOR_RE.test(src.color || '') ? src.color : DEFAULT_GRID.color,
    opacity: num(src.opacity, 0.05, 1, DEFAULT_GRID.opacity),
    scale: num(src.scale, 0.1, 1000, DEFAULT_GRID.scale),
    unit: text(src.unit, 8) || 'm',
    snap: src.snap !== false,
  };
}

function cleanTokens(list) {
  if (!Array.isArray(list)) return [];
  let withImg = 0;
  return list.slice(0, 150).map((t, n) => {
    const tk = t && typeof t === 'object' ? t : {};
    const out = {
      id: text(tk.id, 40) || 't' + n,
      name: text(tk.name, 40),
      color: COLOR_RE.test(tk.color || '') ? tk.color : '#2563eb',
      size: Math.round(num(tk.size, 1, 6, 1)),
      shape: tk.shape === 'square' ? 'square' : 'circle',
      x: num(tk.x, -5000, 20000, 0),
      y: num(tk.y, -5000, 20000, 0),
    };
    if (tk.pgId) out.pgId = text(tk.pgId, 60);
    if (typeof tk.img === 'string' && tk.img.startsWith('data:image/') && tk.img.length <= 9000 && withImg < 40) {
      out.img = tk.img;
      withImg++;
    }
    return out;
  });
}

const publicOf = (rec) => ({
  id: rec.id,
  name: rec.name,
  rev: rec.rev,
  updatedAt: rec.updatedAt,
  bg: rec.bg || null,
  grid: rec.grid,
  tokens: rec.tokens,
});

async function isMaster(token) {
  if (!token) return false;
  const raw = await kGet(LOCK);
  if (!raw) return false;
  try {
    const a = Buffer.from(String(JSON.parse(raw).token));
    const b = Buffer.from(String(token));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function getBoard(id) {
  const raw = id && ID_RE.test(String(id)) ? await hGet(BOARDS, String(id)) : null;
  return raw ? JSON.parse(raw) : null;
}

async function saveBoard(rec) {
  await hSet(BOARDS, rec.id, JSON.stringify(rec));
}

async function publishIfActive(rec) {
  const raw = await kGet(PUBLIC);
  let activeId = null;
  try {
    activeId = raw ? JSON.parse(raw).id : null;
  } catch {
    activeId = null;
  }
  if (activeId === rec.id) await kSet(PUBLIC, JSON.stringify(publicOf(rec)));
}

export default async function handler(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const query = req.query || {};
  const method = req.method;

  if (storeKind() === 'none') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'not_configured' });
  }

  try {
    // ---- lettura libera ----
    if (method === 'GET') {
      if (query.img) {
        const id = String(query.img);
        if (!ID_RE.test(id)) return res.status(404).json({ error: 'not_found' });
        const data = await hGet(IMGS, id);
        if (!data || !data.startsWith(JPEG_PREFIX)) return res.status(404).json({ error: 'not_found' });
        const buf = Buffer.from(data.slice(JPEG_PREFIX.length), 'base64');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Content-Length', String(buf.length));
        return res.end(buf);
      }
      if (query.id) {
        res.setHeader('Cache-Control', 'no-store');
        const rec = await getBoard(query.id);
        if (!rec) return res.status(404).json({ error: 'not_found' });
        return res.status(200).json(publicOf(rec));
      }
      const raw = await kGet(PUBLIC);
      res.setHeader('Cache-Control', 'public, s-maxage=2, stale-while-revalidate=2');
      return res.status(200).json(raw ? JSON.parse(raw) : { empty: true });
    }

    res.setHeader('Cache-Control', 'no-store');
    if (limited(hits, ip, 300, 60_000)) return res.status(429).json({ error: 'rate_limited' });

    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = null;
      }
    }
    body = body && typeof body === 'object' ? body : {};

    const origin = req.headers.origin;
    if (origin) {
      let same = false;
      try {
        same = new URL(origin).host === req.headers.host;
      } catch {
        same = false;
      }
      if (!same) return res.status(403).json({ error: 'forbidden_origin' });
    }
    if (method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    const action = body.action;

    // ---- accesso master ----
    if (action === 'login') {
      const master = process.env.GM_PASSWORD;
      if (!master) return res.status(503).json({ error: 'no_master' });
      if ((fails.get(ip) || []).filter((t) => Date.now() - t < 600_000).length >= 10) {
        return res.status(429).json({ error: 'rate_limited' });
      }
      const a = crypto.createHash('sha256').update(String(body.password || '')).digest();
      const b = crypto.createHash('sha256').update(master).digest();
      if (!crypto.timingSafeEqual(a, b)) {
        limited(fails, ip, 1000, 600_000);
        return res.status(401).json({ error: 'bad_password' });
      }
      const token = crypto.randomBytes(16).toString('hex');
      await kSet(LOCK, JSON.stringify({ token, at: Date.now() }));
      return res.status(200).json({ token });
    }

    // ---- da qui in poi serve essere il master in carica ----
    if (!(await isMaster(body.token))) return res.status(401).json({ error: 'not_master' });

    if (action === 'list') {
      const all = await hGetAll(BOARDS);
      const rawPublic = await kGet(PUBLIC);
      let activeId = null;
      try {
        activeId = rawPublic ? JSON.parse(rawPublic).id : null;
      } catch {
        activeId = null;
      }
      const boards = Object.values(all)
        .map((r) => {
          try {
            const rec = JSON.parse(r);
            return { id: rec.id, name: rec.name, updatedAt: rec.updatedAt, hasBg: !!rec.bg };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((x, y) => x.updatedAt - y.updatedAt);
      return res.status(200).json({ boards, activeId });
    }

    if (action === 'create') {
      const all = await hGetAll(BOARDS);
      if (Object.keys(all).length >= MAX_BOARDS) return res.status(400).json({ error: 'too_many' });
      const id = 'bd_' + crypto.randomBytes(5).toString('hex');
      const now = Date.now();
      const rec = {
        id,
        name: text(body.name, 60) || 'Lavagna ' + (Object.keys(all).length + 1),
        rev: 1,
        updatedAt: now,
        bg: null,
        grid: { ...DEFAULT_GRID },
        tokens: [],
      };
      await saveBoard(rec);
      if (!(await kGet(PUBLIC))) await kSet(PUBLIC, JSON.stringify(publicOf(rec)));
      return res.status(200).json({ id });
    }

    const rec = await getBoard(body.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });

    if (action === 'save') {
      const st = body.state && typeof body.state === 'object' ? body.state : {};
      const next = {
        ...rec,
        name: text(st.name, 60) || rec.name,
        grid: cleanGrid(st.grid),
        tokens: cleanTokens(st.tokens),
        rev: rec.rev + 1,
        updatedAt: Date.now(),
      };
      if (JSON.stringify(next).length > MAX_STATE_CHARS) return res.status(413).json({ error: 'too_large' });
      await saveBoard(next);
      await publishIfActive(next);
      return res.status(200).json({ ok: true, rev: next.rev });
    }

    if (action === 'setBg') {
      const image = String(body.image || '');
      if (!image.startsWith(JPEG_PREFIX)) return res.status(400).json({ error: 'bad_image' });
      if (image.length > MAX_IMG_CHARS) return res.status(413).json({ error: 'too_large' });
      const w = Math.round(num(body.w, 100, 8000, 0));
      const h = Math.round(num(body.h, 100, 8000, 0));
      if (!w || !h) return res.status(400).json({ error: 'bad_image' });
      await hSet(IMGS, rec.id, image);
      const next = { ...rec, bg: { v: Date.now(), w, h }, rev: rec.rev + 1, updatedAt: Date.now() };
      await saveBoard(next);
      await publishIfActive(next);
      return res.status(200).json({ ok: true, bg: next.bg, rev: next.rev });
    }

    if (action === 'clearBg') {
      await hDel(IMGS, rec.id);
      const next = { ...rec, bg: null, rev: rec.rev + 1, updatedAt: Date.now() };
      await saveBoard(next);
      await publishIfActive(next);
      return res.status(200).json({ ok: true, rev: next.rev });
    }

    if (action === 'activate') {
      await kSet(PUBLIC, JSON.stringify(publicOf(rec)));
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete') {
      await hDel(BOARDS, rec.id);
      await hDel(IMGS, rec.id);
      const rawPublic = await kGet(PUBLIC);
      let activeId = null;
      try {
        activeId = rawPublic ? JSON.parse(rawPublic).id : null;
      } catch {
        activeId = null;
      }
      if (activeId === rec.id) {
        const rest = await hGetAll(BOARDS);
        const first = Object.values(rest)[0];
        await kSet(PUBLIC, first ? JSON.stringify(publicOf(JSON.parse(first))) : '');
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'bad_request' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
}
