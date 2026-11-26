// Lavagna condivisa: la vedono tutti, la modifica solo il master (password GM_PASSWORD).
//  - lo stato della lavagna attiva sta in una sola chiave (mm:board_public): chi guarda
//    la legge con 1 comando e la risposta resta in cache sulla rete di Vercel per 2 secondi,
//    quindi il numero di spettatori non fa salire il consumo del database
//  - la mappa (immagine ridotta dal browser) è separata e si scarica una volta sola
//  - un solo master alla volta: un nuovo accesso master prende il controllo e il vecchio passa in sola lettura
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { hGetAll, hGet, hSet, hDel, kGet, kGetMany, kSet, storeKind, get as getPg } from './_store.js';

const scrypt = promisify(crypto.scrypt);

// Il master collegato manda un segnale ogni 30 secondi: se non ne arrivano da 100 secondi
// consideriamo che non ci sia nessuno e chi guarda smette di chiedere aggiornamenti di continuo.
const LIVE_MS = 100_000;
// Due "stanze" separate: quella ufficiale e quella di prova (?room=prova). Hanno lavagne, mappe,
// stato attivo e accesso master propri: quello che si fa in prova non tocca nulla di ufficiale.
const roomKeys = (prefix) => ({
  BOARDS: prefix + 'boards',
  IMGS: prefix + 'board_imgs',
  PUBLIC: prefix + 'board_public',
  REV: prefix + 'board_rev',
  LIVE: prefix + 'board_live',
  LOCK: prefix + 'board_lock',
  NPC: prefix + 'board_npcs',
});
const ROOMS = { official: roomKeys('mm:'), prova: roomKeys('mm:prova_') };
const roomCtx = new AsyncLocalStorage();
const K = () => roomCtx.getStore() || ROOMS.official;
const MAX_BOARDS = 20;
const MAX_NPCS = 60;
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
    if (typeof tk.npcId === 'string' && /^npc_[a-f0-9]{6,20}$/.test(tk.npcId)) out.npcId = tk.npcId;
    if (tk.hid === true) out.hid = true;
    if (typeof tk.cls === 'string' && tk.cls.trim()) out.cls = text(tk.cls.trim(), 40);
    if (tk.mov !== undefined && tk.mov !== null && tk.mov !== '' && Number.isFinite(Number(tk.mov))) out.mov = Math.round(num(tk.mov, 0, 999, 0) * 10) / 10;
    if (typeof tk.wl === 'string' && tk.wl.trim()) out.wl = text(tk.wl.trim(), 24);
    const iniAt = Math.round(num(tk.iniAt, 0, 9e15, 0));
    if (iniAt > 0) out.iniAt = iniAt;
    const syncAt = Math.round(num(tk.syncAt, 0, 9e15, 0));
    if (syncAt > 0) out.syncAt = syncAt;
    const pv = Math.round(num(tk.pv, 0, 1e9, 0));
    if (pv > 0) out.pv = pv;
    if (tk.ini !== undefined && tk.ini !== null && tk.ini !== '' && Number.isFinite(Number(tk.ini))) out.ini = Math.round(num(tk.ini, -999, 9999, 0));
    const wound = Math.round(num(tk.wound, 0, 3, 0));
    if (wound > 0) out.wound = wound;
    if (typeof tk.img === 'string' && tk.img.startsWith('data:image/') && tk.img.length <= 9000 && withImg < 40) {
      out.img = tk.img;
      withImg++;
    }
    return out;
  });
}

// Turni di combattimento: l'ordine tra pedine con la stessa iniziativa, chi ha il turno e il round.
// Se un giocatore ha mandato iniziativa o ferite dopo l'ultima lettura del master, il salvataggio del master non le cancella.
function keepNewer(incoming, stored) {
  const old = new Map((stored || []).map((x) => [x.id, x]));
  return incoming.map((t) => {
    const o = old.get(t.id);
    if (!o || !t.pgId) return t;
    const r = { ...t };
    if ((o.pv || 0) > (t.pv || 0)) {
      r.pv = o.pv;
      r.x = o.x;
      r.y = o.y;
    }
    if ((o.iniAt || 0) > (t.iniAt || 0)) {
      r.iniAt = o.iniAt;
      if (o.ini !== undefined) r.ini = o.ini;
    }
    if ((o.syncAt || 0) > (t.syncAt || 0)) {
      r.syncAt = o.syncAt;
      for (const k of ['wound', 'wl', 'cls', 'mov']) {
        if (o[k] !== undefined) r[k] = o[k];
        else delete r[k];
      }
    }
    return r;
  });
}

async function pgPasswordOk(rec, password) {
  const pw = String(password || '');
  if (!pw || !rec) return false;
  const master = process.env.GM_PASSWORD;
  if (master) {
    const a = crypto.createHash('sha256').update(pw).digest();
    const b = crypto.createHash('sha256').update(master).digest();
    if (crypto.timingSafeEqual(a, b)) return true;
  }
  if (!rec.salt || !rec.hash) return false;
  const key = await scrypt(pw, rec.salt, 32);
  const stored = Buffer.from(rec.hash, 'hex');
  return stored.length === key.length && crypto.timingSafeEqual(stored, key);
}

// NPC fissi: pedine salvate dal master, richiamabili su ogni lavagna (solo aspetto, classe e movimento).
function cleanNpc(src, id) {
  const t = cleanTokens([{ ...(src && typeof src === 'object' ? src : {}), id: 'x' }])[0];
  const out = { id, name: t.name.trim(), color: t.color, size: t.size, shape: t.shape };
  if (t.img) out.img = t.img;
  if (t.cls) out.cls = t.cls;
  if (t.mov !== undefined) out.mov = t.mov;
  return out;
}

async function listNpcs() {
  return Object.values(await hGetAll(K().NPC))
    .map((r) => {
      try {
        return JSON.parse(r);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'it'));
}

function cleanTurn(t) {
  const src = t && typeof t === 'object' ? t : {};
  const order = [];
  for (const id of Array.isArray(src.order) ? src.order.slice(0, 150) : []) {
    const v = text(id, 40);
    if (v && !order.includes(v)) order.push(v);
  }
  return { order, active: text(src.active, 40), round: Math.round(num(src.round, 1, 999, 1)) };
}

// Effetti di gioco (aree di spell, ecc.): cerchi o quadrati con un testo, grandi quanto vuole il master.
function cleanEffects(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 80).map((e, n) => {
    const ef = e && typeof e === 'object' ? e : {};
    return {
      id: text(ef.id, 40) || 'e' + n,
      label: text(ef.label, 40),
      shape: ef.shape === 'square' ? 'square' : 'circle',
      color: COLOR_RE.test(ef.color || '') ? ef.color : '#ef4444',
      opacity: num(ef.opacity, 0.05, 0.9, 0.35),
      radius: num(ef.radius, 0.2, 500, 3),
      x: num(ef.x, -5000, 20000, 0),
      y: num(ef.y, -5000, 20000, 0),
    };
  });
}

// Disegni a mano libera: ogni tratto è una spezzata di punti [x1,y1,x2,y2,...] in pixel della mappa.
function cleanDrawings(list) {
  if (!Array.isArray(list)) return [];
  let budget = 40000;
  const out = [];
  for (const d of list.slice(0, 300)) {
    const src = d && typeof d === 'object' ? d : {};
    const arr = Array.isArray(src.p) ? src.p.slice(0, 2000) : [];
    const pts = [];
    for (let k = 0; k + 1 < arr.length; k += 2) {
      pts.push(Math.round(num(arr[k], -5000, 20000, 0)), Math.round(num(arr[k + 1], -5000, 20000, 0)));
    }
    if (pts.length < 4) continue;
    if (budget - pts.length < 0) break;
    budget -= pts.length;
    out.push({
      id: text(src.id, 40) || 'd' + out.length,
      color: COLOR_RE.test(src.color || '') ? src.color : '#dc2626',
      width: Math.round(num(src.width, 1, 40, 4)),
      p: pts,
    });
  }
  return out;
}

// Nebbia di guerra: la mappa è tutta coperta, i tratti "rivela" (r) la scoprono e quelli "nascondi" (h) la ricoprono.
// Ogni tratto è un pennello (w = spessore, p = spezzata di punti) oppure, con t:'r', un rettangolo p = [x1,y1,x2,y2].
const FOG_BUDGET = 30000;
const EMPTY_FOG = { on: false, strokes: [] };

function cleanFog(f) {
  const src = f && typeof f === 'object' ? f : {};
  let budget = FOG_BUDGET;
  const strokes = [];
  for (const s of (Array.isArray(src.strokes) ? src.strokes : []).slice(0, 500)) {
    const o = s && typeof s === 'object' ? s : {};
    const m = o.m === 'h' ? 'h' : 'r';
    const arr = Array.isArray(o.p) ? o.p.slice(0, 2000) : [];
    if (o.t === 'r') {
      if (arr.length < 4 || budget < 4) continue;
      const v = arr.slice(0, 4).map((n) => Math.round(num(n, -5000, 20000, 0)));
      budget -= 4;
      strokes.push({ m, t: 'r', p: [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])] });
      continue;
    }
    const pts = [];
    for (let k = 0; k + 1 < arr.length; k += 2) {
      pts.push(Math.round(num(arr[k], -5000, 20000, 0)), Math.round(num(arr[k + 1], -5000, 20000, 0)));
    }
    if (pts.length < 4 || budget - pts.length < 0) continue;
    budget -= pts.length;
    strokes.push({ m, w: Math.round(num(o.w, 6, 600, 60)), p: pts });
  }
  return { on: src.on === true, strokes };
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

// Il punto è scoperto se l'ultimo tratto che lo tocca è un "rivela".
function fogRevealed(strokes, x, y) {
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    if (s.t === 'r') {
      if (x >= s.p[0] && x <= s.p[2] && y >= s.p[1] && y <= s.p[3]) return s.m === 'r';
      continue;
    }
    const r2 = (s.w / 2) * (s.w / 2);
    for (let k = 0; k + 3 < s.p.length; k += 2) {
      if (segDist2(x, y, s.p[k], s.p[k + 1], s.p[k + 2], s.p[k + 3]) <= r2) return s.m === 'r';
    }
  }
  return false;
}

// Simboli e testi sulla mappa: t = 's' simbolo (k = nome del simbolo) oppure 'x' testo. x,y in pixel della mappa.
function cleanMarks(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 400)
    .map((m, n) => {
      const o = m && typeof m === 'object' ? m : {};
      const tt = o.t === 'x' ? 'x' : 's';
      const out = {
        id: text(o.id, 40) || 'm' + n,
        t: tt,
        x: num(o.x, -5000, 20000, 0),
        y: num(o.y, -5000, 20000, 0),
        s: Math.round(num(o.s, 0.25, 12, 1) * 100) / 100,
        r: Math.round(num(o.r, 0, 359, 0)),
        color: COLOR_RE.test(o.color || '') ? o.color : '#111827',
      };
      if (tt === 's') out.k = /^[a-z0-9_]{1,30}$/.test(String(o.k || '')) ? String(o.k) : 'porta';
      if (typeof o.text === 'string' && o.text.trim()) out.text = text(o.text.trim(), tt === 'x' ? 200 : 60);
      if (o.hid === true) out.hid = true;
      return out;
    })
    .filter((m) => m.t === 's' || m.text);
}

const publicOf = (rec) => ({
  id: rec.id,
  name: rec.name,
  rev: rec.rev,
  updatedAt: rec.updatedAt,
  bg: rec.bg || null,
  grid: rec.grid,
  tokens: rec.tokens,
  effects: rec.effects || [],
  drawings: rec.drawings || [],
  turn: rec.turn || { order: [], active: '', round: 1 },
  fog: rec.fog || EMPTY_FOG,
  marks: rec.marks || [],
  symLabels: rec.symLabels !== false,
});

// Quello che vedono i giocatori: le pedine nascoste o coperte dalla nebbia NON vengono nemmeno inviate
// (i PG ufficiali restano sempre visibili, a meno che il master non li nasconda a mano).
function playerOf(rec) {
  const pub = publicOf(rec);
  const gs = (rec.grid && rec.grid.size) || DEFAULT_GRID.size;
  pub.tokens = (rec.tokens || []).filter((t) => {
    if (t.hid) return false;
    if (!pub.fog.on || t.pgId || t.npcId) return true;
    const half = (gs * t.size) / 2;
    return fogRevealed(pub.fog.strokes, t.x + half, t.y + half);
  });
  // simboli e testi: via quelli nascosti dal master e quelli sotto la nebbia
  pub.marks = (rec.marks || []).filter((m) => {
    if (m.hid) return false;
    if (!pub.fog.on) return true;
    const half = m.t === 'x' ? 0 : (gs * m.s) / 2;
    return fogRevealed(pub.fog.strokes, m.x + half, m.y + half);
  });
  return pub;
}

// Scrive la lavagna attiva e il suo "numero di versione": chi guarda legge solo quello (pochi byte)
// e scarica lo stato completo soltanto quando il numero cambia.
async function publish(rec) {
  await kSet(K().PUBLIC, rec ? JSON.stringify(playerOf(rec)) : '');
  await kSet(K().REV, rec ? rec.id + ':' + rec.rev : '');
}

async function isMaster(token) {
  if (!token) return false;
  const raw = await kGet(K().LOCK);
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
  const raw = id && ID_RE.test(String(id)) ? await hGet(K().BOARDS, String(id)) : null;
  return raw ? JSON.parse(raw) : null;
}

async function saveBoard(rec) {
  await hSet(K().BOARDS, rec.id, JSON.stringify(rec));
}

async function publishIfActive(rec) {
  const raw = await kGet(K().PUBLIC);
  let activeId = null;
  try {
    activeId = raw ? JSON.parse(raw).id : null;
  } catch {
    activeId = null;
  }
  if (activeId === rec.id) await publish(rec);
}

export default function handler(req, res) {
  const room = String((req.query || {}).room || '') === 'prova' ? ROOMS.prova : ROOMS.official;
  return roomCtx.run(room, () => main(req, res));
}

async function main(req, res) {
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
        const data = await hGet(K().IMGS, id);
        if (!data || !data.startsWith(JPEG_PREFIX)) return res.status(404).json({ error: 'not_found' });
        const buf = Buffer.from(data.slice(JPEG_PREFIX.length), 'base64');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Content-Length', String(buf.length));
        return res.end(buf);
      }
      if (query.poll) {
        const [revRaw, liveRaw] = await kGetMany([K().REV, K().LIVE]);
        let k = revRaw;
        const live = Date.now() - Number(liveRaw || 0) < LIVE_MS;
        if (!k) {
          // lavagne create prima dell'introduzione del numero di versione: lo ricava e lo salva
          const rawPublic = await kGet(K().PUBLIC);
          if (rawPublic) {
            const cur = JSON.parse(rawPublic);
            k = cur.id + ':' + cur.rev;
            await kSet(K().REV, k);
          }
        }
        // master collegato: risposta condivisa per 3 secondi; non collegato: per 10, così chi guarda non consuma quasi nulla
        res.setHeader('Cache-Control', live ? 'public, s-maxage=3, stale-while-revalidate=3' : 'public, s-maxage=10, stale-while-revalidate=10');
        return res.status(200).json({ k: k || '', live });
      }
      if (query.id) {
        res.setHeader('Cache-Control', 'no-store');
        const rec = await getBoard(query.id);
        if (!rec) return res.status(404).json({ error: 'not_found' });
        return res.status(200).json(playerOf(rec));
      }
      const raw = await kGet(K().PUBLIC);
      res.setHeader('Cache-Control', 'public, s-maxage=3, stale-while-revalidate=3');
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
      await kSet(K().LOCK, JSON.stringify({ token, at: Date.now() }));
      await kSet(K().LIVE, String(Date.now()));
      return res.status(200).json({ token });
    }

    // ---- un giocatore manda iniziativa / ferite / classe / movimento della sua pedina (password del suo PG) ----
    if (action === 'pgSync') {
      const pgId = String(body.pgId || '');
      if (!/^[A-Za-z0-9_-]{6,60}$/.test(pgId)) return res.status(400).json({ error: 'bad_request' });
      if ((fails.get(ip) || []).filter((x) => Date.now() - x < 600_000).length >= 10) return res.status(429).json({ error: 'rate_limited' });
      const pg = await getPg(pgId);
      if (!pg || !(await pgPasswordOk(pg, body.password))) {
        limited(fails, ip, 1000, 600_000);
        return res.status(401).json({ error: 'bad_password' });
      }
      const upd = {};
      if (body.ini !== undefined && Number.isFinite(Number(body.ini))) upd.ini = Math.round(num(body.ini, -999, 9999, 0));
      if (body.wound !== undefined) upd.wound = Math.round(num(body.wound, 0, 3, 0));
      if (typeof body.wl === 'string') upd.wl = text(body.wl.trim(), 24);
      if (typeof body.cls === 'string') upd.cls = text(body.cls.trim(), 40);
      if (body.mov !== undefined && Number.isFinite(Number(body.mov))) upd.mov = Math.round(num(body.mov, 0, 999, 0) * 10) / 10;
      const now = Date.now();
      let updated = 0;
      for (const raw of Object.values(await hGetAll(K().BOARDS))) {
        let b;
        try {
          b = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!(b.tokens || []).some((x) => x.pgId === pgId)) continue;
        b.tokens = b.tokens.map((x) => {
          if (x.pgId !== pgId) return x;
          const n = { ...x };
          if (upd.ini !== undefined) {
            n.ini = upd.ini;
            n.iniAt = now;
          }
          if (upd.wound !== undefined || upd.wl !== undefined || upd.cls !== undefined || upd.mov !== undefined) {
            if (upd.wound !== undefined) {
              if (upd.wound > 0) n.wound = upd.wound;
              else delete n.wound;
            }
            if (upd.wl !== undefined) {
              if (upd.wl) n.wl = upd.wl;
              else delete n.wl;
            }
            if (upd.cls !== undefined) {
              if (upd.cls) n.cls = upd.cls;
              else delete n.cls;
            }
            if (upd.mov !== undefined) n.mov = upd.mov;
            n.syncAt = now;
          }
          return n;
        });
        b.rev = (b.rev || 1) + 1;
        b.updatedAt = now;
        await saveBoard(b);
        await publishIfActive(b);
        updated++;
      }
      return res.status(200).json({ ok: true, updated });
    }

    // ---- un giocatore sposta la propria pedina sulla lavagna attiva (password del suo PG) ----
    if (action === 'pgMove') {
      const pgId = String(body.pgId || '');
      const tokenId = String(body.tokenId || '');
      const x = Number(body.x);
      const y = Number(body.y);
      if (!/^[A-Za-z0-9_-]{6,60}$/.test(pgId) || !tokenId || !Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'bad_request' });
      if ((fails.get(ip) || []).filter((v) => Date.now() - v < 600_000).length >= 10) return res.status(429).json({ error: 'rate_limited' });
      const pg = await getPg(pgId);
      if (!pg || !(await pgPasswordOk(pg, body.password))) {
        limited(fails, ip, 1000, 600_000);
        return res.status(401).json({ error: 'bad_password' });
      }
      let activeId = null;
      try {
        activeId = JSON.parse(await kGet(K().PUBLIC)).id;
      } catch {
        activeId = null;
      }
      const b = await getBoard(activeId);
      if (!b) return res.status(404).json({ error: 'not_found' });
      let pv = 0;
      b.tokens = (b.tokens || []).map((tk) => {
        // solo la propria pedina, e non se il master l'ha nascosta
        if (tk.id !== tokenId || tk.pgId !== pgId || tk.hid) return tk;
        pv = (tk.pv || 0) + 1;
        return { ...tk, x: Math.round(num(x, -5000, 20000, 0)), y: Math.round(num(y, -5000, 20000, 0)), pv };
      });
      if (!pv) return res.status(404).json({ error: 'not_on_board' });
      b.rev = (b.rev || 1) + 1;
      b.updatedAt = Date.now();
      await saveBoard(b);
      await publish(b);
      return res.status(200).json({ ok: true, pv, rev: b.rev });
    }

    // ---- da qui in poi serve essere il master in carica ----
    if (!(await isMaster(body.token))) return res.status(401).json({ error: 'not_master' });

    // segnale di presenza del master (ogni 30 secondi) e uscita
    if (action === 'ping') {
      await kSet(K().LIVE, String(Date.now()));
      return res.status(200).json({ ok: true });
    }
    if (action === 'away') {
      await kSet(K().LIVE, '0');
      return res.status(200).json({ ok: true });
    }
    if (action === 'logout') {
      await kSet(K().LIVE, '0');
      await kSet(K().LOCK, '');
      return res.status(200).json({ ok: true });
    }

    if (action === 'list') {
      const all = await hGetAll(K().BOARDS);
      const rawPublic = await kGet(K().PUBLIC);
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
      return res.status(200).json({ boards, activeId, npcs: await listNpcs() });
    }

    if (action === 'npcSave') {
      const src = body.npc && typeof body.npc === 'object' ? body.npc : {};
      const all = await hGetAll(K().NPC);
      let id = String(src.id || '');
      if (!Object.prototype.hasOwnProperty.call(all, id)) {
        if (Object.keys(all).length >= MAX_NPCS) return res.status(400).json({ error: 'too_many_npc' });
        id = 'npc_' + crypto.randomBytes(5).toString('hex');
      }
      const npc = cleanNpc(src, id);
      if (!npc.name) return res.status(400).json({ error: 'bad_request' });
      await hSet(K().NPC, id, JSON.stringify(npc));
      return res.status(200).json({ ok: true, npc, npcs: await listNpcs() });
    }

    if (action === 'npcDelete') {
      const id = String(body.npcId || '');
      if (/^npc_[a-f0-9]{6,20}$/.test(id)) await hDel(K().NPC, id);
      return res.status(200).json({ ok: true, npcs: await listNpcs() });
    }

    if (action === 'create') {
      const all = await hGetAll(K().BOARDS);
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
        effects: [],
        drawings: [],
        turn: { order: [], active: '', round: 1 },
        fog: { on: false, strokes: [] },
        marks: [],
        symLabels: true,
      };
      await saveBoard(rec);
      if (!(await kGet(K().PUBLIC))) await publish(rec);
      return res.status(200).json({ id });
    }

    const rec = await getBoard(body.id);
    if (!rec) return res.status(404).json({ error: 'not_found' });

    // il master legge la lavagna completa (senza filtri della nebbia)
    if (action === 'get') return res.status(200).json(publicOf(rec));

    if (action === 'save') {
      const st = body.state && typeof body.state === 'object' ? body.state : {};
      const next = {
        ...rec,
        name: text(st.name, 60) || rec.name,
        grid: cleanGrid(st.grid),
        tokens: keepNewer(cleanTokens(st.tokens), rec.tokens),
        effects: cleanEffects(st.effects),
        drawings: cleanDrawings(st.drawings),
        turn: cleanTurn(st.turn),
        fog: st.fog === undefined ? rec.fog || { on: false, strokes: [] } : cleanFog(st.fog),
        marks: st.marks === undefined ? rec.marks || [] : cleanMarks(st.marks),
        symLabels: st.symLabels === undefined ? rec.symLabels !== false : st.symLabels !== false,
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
      await hSet(K().IMGS, rec.id, image);
      const next = { ...rec, bg: { v: Date.now(), w, h }, rev: rec.rev + 1, updatedAt: Date.now() };
      await saveBoard(next);
      await publishIfActive(next);
      return res.status(200).json({ ok: true, bg: next.bg, rev: next.rev });
    }

    if (action === 'clearBg') {
      await hDel(K().IMGS, rec.id);
      const next = { ...rec, bg: null, rev: rec.rev + 1, updatedAt: Date.now() };
      await saveBoard(next);
      await publishIfActive(next);
      return res.status(200).json({ ok: true, rev: next.rev });
    }

    if (action === 'activate') {
      await publish(rec);
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete') {
      await hDel(K().BOARDS, rec.id);
      await hDel(K().IMGS, rec.id);
      const rawPublic = await kGet(K().PUBLIC);
      let activeId = null;
      try {
        activeId = rawPublic ? JSON.parse(rawPublic).id : null;
      } catch {
        activeId = null;
      }
      if (activeId === rec.id) {
        const rest = await hGetAll(K().BOARDS);
        const first = Object.values(rest)[0];
        await publish(first ? JSON.parse(first) : null);
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'bad_request' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
}
