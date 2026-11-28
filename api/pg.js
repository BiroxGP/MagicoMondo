// PG ufficiali: lettura libera per tutti, scrittura protetta da password.
//  - ogni PG ha la sua password (scelta quando lo si rende ufficiale)
//  - la password master (variabile d'ambiente GM_PASSWORD) può modificare/eliminare qualsiasi PG
//  - un giocatore (campo "player") può avere un solo PG ufficiale
//  - con la propria password un PG può mandare ad altri PG effetti temporanei (bonus/malus): stanno in un
//    archivio a parte, non modificano le schede, e chi li riceve può toglierli
//  - area di prova (?room=prova): stessi comandi su un archivio separato; serve il pass di prova
//    (intestazione x-mm-test), che si ottiene con la password master e vale anche come password dei PG di prova
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { getAll, get, put, del, hGetAll, hSet, hDel, storeKind, testRoom } from './_store.js';
import { isMaster, makeTestPass, validTestPass } from './_test.js';

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

const inTest = () => !!testRoom.getStore();

async function checkPassword(rec, password) {
  const pw = String(password || '');
  if (isMaster(pw) || (inTest() && validTestPass(pw))) return 'master';
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
    primaryClassLevel: c.primaryClassLevel || 0,
    secondaryClassLevel: c.secondaryClassLevel || 0,
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

// ---- effetti temporanei ricevuti da altri PG ----
// Un campo per effetto (mittente~id): due invii contemporanei non si sovrascrivono.
const fxKey = (id) => (inTest() ? 'mm:prova_pgfx:' : 'mm:pgfx:') + id;
const FXID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_FX = 40;
const cut = (s, n) => String(s || '').trim().slice(0, n);

function cleanEffect(e) {
  if (!e || !FXID_RE.test(String(e.id || ''))) return null;
  // una cura: vite da togliere ai danni del bersaglio (la applica la sua scheda)
  const heal = Math.floor(Number(e.heal));
  if (heal > 0 && heal <= 99) return { id: String(e.id), name: cut(e.name, 60) || 'Cura', dur: '', mods: [], heal };
  const mods = (Array.isArray(e.mods) ? e.mods : [])
    .slice(0, 30)
    .map((m) => ({ k: cut(m && m.k, 90), v: Math.round(Number(m && m.v) * 100) / 100 }))
    .filter((m) => m.k && Number.isFinite(m.v) && m.v !== 0 && Math.abs(m.v) <= 999);
  // senza numeri vale solo per gli effetti di un incantesimo (uno stato: nome e durata)
  if (!mods.length && e.free !== true) return null;
  return { id: String(e.id), name: cut(e.name, 60) || 'Effetto', dur: cut(e.dur, 60), mods };
}

async function readFx(id) {
  const list = [];
  for (const [key, value] of Object.entries(await hGetAll(fxKey(id)))) {
    try {
      list.push({ ...JSON.parse(value), key });
    } catch {
      /* voce illeggibile: ignorata */
    }
  }
  return list.sort((a, b) => (a.at || 0) - (b.at || 0));
}

const idList = (value, self) =>
  [...new Set(Array.isArray(value) ? value.map(String) : [])].filter((x) => x !== self && ID_RE.test(x)).slice(0, MAX_FX);

export default function handler(req, res) {
  return testRoom.run(String((req.query || {}).room || '') === 'prova', () => main(req, res));
}

async function main(req, res) {
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
    // ---- ingresso nell'area di prova ----
    if (method === 'POST' && body.action === 'testLogin') {
      if (!process.env.GM_PASSWORD) return res.status(503).json({ error: 'no_master' });
      if (failedTooOften(ip)) return res.status(429).json({ error: 'rate_limited' });
      if (!isMaster(body.password)) {
        noteFailure(ip);
        return res.status(401).json({ error: 'bad_password' });
      }
      return res.status(200).json({ pass: makeTestPass() });
    }
    // nell'area di prova anche la lettura richiede il pass
    if (inTest() && !validTestPass(req.headers['x-mm-test'])) return res.status(401).json({ error: 'test_auth' });

    // ---- lettura (libera per i PG ufficiali) ----
    if (method === 'GET') {
      if (query.fx) {
        if (!ID_RE.test(query.fx)) return res.status(404).json({ error: 'not_found' });
        return res.status(200).json({ fx: await readFx(query.fx) });
      }
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

    // ---- area di prova: crea un PG (senza password, anche più di uno per giocatore) ----
    if (method === 'POST' && action === 'create' && inTest()) {
      const newId = 'pgt_' + crypto.randomBytes(6).toString('hex');
      const player = String((body.character && body.character.player) || '').trim() || 'Prova';
      const character = cleanCharacter({ ...body.character, player }, newId);
      if (!character) return res.status(400).json({ error: 'bad_request' });
      if (JSON.stringify(character).length > MAX_BYTES) return res.status(413).json({ error: 'too_large' });
      const now = Date.now();
      await put(newId, { character, rev: 1, createdAt: now, updatedAt: now });
      return res.status(200).json({ id: newId, rev: 1 });
    }

    // ---- area di prova: copia un PG ufficiale (stesso identificativo; l'originale viene solo letto) ----
    if (method === 'POST' && action === 'testCopy' && inTest()) {
      const source = String(body.sourceId || '');
      if (!ID_RE.test(source)) return res.status(404).json({ error: 'not_found' });
      const original = await testRoom.run(false, () => get(source));
      if (!original) return res.status(404).json({ error: 'not_found' });
      const previous = await get(source);
      const rev = previous ? (previous.rev || 1) + 1 : 1;
      const now = Date.now();
      const character = cleanCharacter(original.character, source);
      if (!character) return res.status(400).json({ error: 'bad_request' });
      await put(source, { character, rev, createdAt: now, updatedAt: now });
      return res.status(200).json({ id: source, rev });
    }

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
      // il controllo del giocatore doppio serve solo se il nome giocatore è cambiato: evita di leggere
      // tutti i PG a ogni salvataggio (più lento e più comandi sul database)
      if (!inTest() && normPlayer(character.player) !== normPlayer(rec.character && rec.character.player)) {
        const all = await getAll();
        const taken = playerTaken(all, character.player, String(id));
        if (taken) return res.status(409).json({ error: 'player_taken', id: taken.id, name: taken.name });
      }
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

    // manda (o ritira) un proprio effetto ad altri PG: qui "id" è il PG che lo lancia
    if (method === 'POST' && action === 'fxSend') {
      const fxId = String((body.effect && body.effect.id) || '');
      if (!FXID_RE.test(fxId)) return res.status(400).json({ error: 'bad_request' });
      const targets = idList(body.targets, String(id));
      const remove = idList(body.remove, String(id)).filter((x) => !targets.includes(x));
      const effect = targets.length ? cleanEffect(body.effect) : null;
      if (targets.length && !effect) return res.status(400).json({ error: 'bad_request' });
      const field = String(id) + '~' + fxId;
      const from = { id: String(id), name: cut(rec.character && rec.character.name, 60) };
      const sent = [];
      const missing = [];
      const full = [];
      for (const target of targets) {
        if (!(await get(target))) {
          missing.push(target);
          continue;
        }
        const inbox = await hGetAll(fxKey(target));
        if (!inbox[field] && Object.keys(inbox).length >= MAX_FX) {
          full.push(target);
          continue;
        }
        await hSet(fxKey(target), field, JSON.stringify({ ...effect, from, at: Date.now() }));
        sent.push(target);
      }
      for (const target of remove) await hDel(fxKey(target), field);
      return res.status(200).json({ ok: true, sent, missing, full });
    }

    // toglie effetti ricevuti: qui "id" è il PG che li ha addosso
    if (method === 'POST' && action === 'fxDrop') {
      const keys = (Array.isArray(body.keys) ? body.keys : []).slice(0, MAX_FX * 2);
      for (const key of keys) await hDel(fxKey(String(id)), String(key).slice(0, 120));
      return res.status(200).json({ ok: true });
    }

    if (method === 'POST' && action === 'delete') {
      for (const key of Object.keys(await hGetAll(fxKey(String(id))))) await hDel(fxKey(String(id)), key);
      await del(String(id));
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'bad_request' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
}
