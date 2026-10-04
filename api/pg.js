// PG ufficiali: lettura libera per tutti, scrittura protetta da password.
//  - ogni PG ha la sua password (scelta quando lo si rende ufficiale)
//  - la password master (variabile d'ambiente GM_PASSWORD) può modificare/eliminare qualsiasi PG
//  - un giocatore (campo "player") può avere un solo PG ufficiale
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { getAll, get, put, del, storeKind } from './_store.js';

const scrypt = promisify(crypto.scrypt);
const MAX_BYTES = 900_000;
const ID_RE = /^[A-Za-z0-9_-]{6,60}$/;

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

const failedTooOften = (ip) => (fails.get(ip) || []).filter((t) => Date.now() - t < 600_000).length >= 10;
const noteFailure = (ip) => limited(fails, ip, 1000, 600_000);

const normPlayer = (s) => String(s || '').trim().split(' ').filter(Boolean).join(' ').toLowerCase();

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 32);
  return { salt, hash: key.toString('hex') };
}

async function checkPassword(rec, password) {
  const master = process.env.GM_PASSWORD;
  const pw = String(password || '');
  if (master) {
    const a = crypto.createHash('sha256').update(pw).digest();
    const b = crypto.createHash('sha256').update(master).digest();
    if (crypto.timingSafeEqual(a, b)) return 'master';
  }
  if (!rec || !rec.salt || !pw) return null;
  const key = await scrypt(pw, rec.salt, 32);
  const stored = Buffer.from(rec.hash, 'hex');
  return stored.length === key.length && crypto.timingSafeEqual(stored, key) ? 'owner' : null;
}

function summary(id, rec) {
  const c = rec.character || {};
  return {
    id,
    name: c.name || '',
    player: c.player || '',
    level: c.level || 1,
    primaryClassId: c.primaryClassId || '',
    secondaryClassId: c.secondaryClassId || '',
    archetypeRace: c.archetypeRace || '',
    updatedAt: rec.updatedAt || 0,
  };
}

function cleanCharacter(character, id) {
  if (!character || typeof character !== 'object' || typeof character.name !== 'string' || !character.attributes) {
    return null;
  }
  return { ...character, id, official: true, isPlayCopy: true };
}

function playerTaken(all, player, exceptId) {
  const n = normPlayer(player);
  for (const [id, rec] of Object.entries(all)) {
    if (id !== exceptId && normPlayer(rec.character && rec.character.player) === n) {
      return { id, name: rec.character.name };
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(hits, ip, 240, 60_000)) return res.status(429).json({ error: 'rate_limited' });

  if (storeKind() === 'none') return res.status(503).json({ error: 'not_configured' });

  const method = req.method;
  const query = req.query || {};
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  body = body && typeof body === 'object' ? body : {};

  if (method !== 'GET') {
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
  }

  try {
    // ---- lettura (libera) ----
    if (method === 'GET') {
      if (query.id) {
        if (!ID_RE.test(query.id)) return res.status(404).json({ error: 'not_found' });
        const rec = await get(query.id);
        if (!rec) return res.status(404).json({ error: 'not_found' });
        return res.status(200).json({ character: rec.character, rev: rec.rev || 1 });
      }
      const all = await getAll();
      const list = Object.entries(all).map(([id, rec]) => summary(id, rec));
      list.sort((a, b) => a.player.localeCompare(b.player, 'it') || a.name.localeCompare(b.name, 'it'));
      return res.status(200).json({ list });
    }

    const action = body.action;

    // ---- rendere ufficiale un PG ----
    if (method === 'POST' && action === 'create') {
      const password = String(body.password || '');
      if (password.length < 4) return res.status(400).json({ error: 'password_short' });
      const player = String((body.character && body.character.player) || '').trim();
      if (!player) return res.status(400).json({ error: 'player_required' });
      const id = 'pg_' + crypto.randomBytes(6).toString('hex');
      const character = cleanCharacter({ ...body.character, player }, id);
      if (!character) return res.status(400).json({ error: 'bad_request' });
      if (JSON.stringify(character).length > MAX_BYTES) return res.status(413).json({ error: 'too_large' });
      const all = await getAll();
      const taken = playerTaken(all, player, id);
      if (taken) return res.status(409).json({ error: 'player_taken', id: taken.id, name: taken.name });
      const { salt, hash } = await hashPassword(password);
      const now = Date.now();
      await put(id, { character, salt, hash, rev: 1, createdAt: now, updatedAt: now });
      return res.status(200).json({ id, rev: 1 });
    }

    const id = query.id || body.id;
    if (!id || !ID_RE.test(String(id))) return res.status(404).json({ error: 'not_found' });
    const rec = await get(String(id));
    if (!rec) return res.status(404).json({ error: 'not_found' });

    // ---- verifica password ----
    if (method === 'POST' && action === 'verify') {
      if (failedTooOften(ip)) return res.status(429).json({ error: 'rate_limited' });
      const who = await checkPassword(rec, body.password);
      if (!who) {
        noteFailure(ip);
        return res.status(401).json({ error: 'bad_password' });
      }
      return res.status(200).json({ ok: true, master: who === 'master' });
    }

    // ---- da qui in poi serve la password ----
    if (failedTooOften(ip)) return res.status(429).json({ error: 'rate_limited' });
    const who = await checkPassword(rec, body.password);
    if (!who) {
      noteFailure(ip);
      return res.status(401).json({ error: 'bad_password' });
    }

    if (method === 'PUT') {
      if (!body.force && Number(body.rev) !== (rec.rev || 1)) {
        return res.status(409).json({ error: 'conflict', rev: rec.rev || 1 });
      }
      const character = cleanCharacter(body.character, String(id));
      if (!character) return res.status(400).json({ error: 'bad_request' });
      if (!String(character.player || '').trim()) return res.status(400).json({ error: 'player_required' });
      if (JSON.stringify(character).length > MAX_BYTES) return res.status(413).json({ error: 'too_large' });
      const all = await getAll();
      const taken = playerTaken(all, character.player, String(id));
      if (taken) return res.status(409).json({ error: 'player_taken', id: taken.id, name: taken.name });
      const rev = (rec.rev || 1) + 1;
      await put(String(id), { ...rec, character, rev, updatedAt: Date.now() });
      return res.status(200).json({ ok: true, rev });
    }

    if (method === 'POST' && action === 'setPassword') {
      const next = String(body.newPassword || '');
      if (next.length < 4) return res.status(400).json({ error: 'password_short' });
      const { salt, hash } = await hashPassword(next);
      await put(String(id), { ...rec, salt, hash, updatedAt: Date.now() });
      return res.status(200).json({ ok: true });
    }

    if (method === 'POST' && action === 'delete') {
      await del(String(id));
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'bad_request' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
}
