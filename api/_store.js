// Archivio condiviso (PG ufficiali e lavagne).
// In produzione usa Redis (Upstash, collegato da Vercel → Storage): le variabili
// KV_REST_API_URL / KV_REST_API_TOKEN (o UPSTASH_REDIS_REST_URL / _TOKEN) vengono create da Vercel.
// In locale (npm run dev) ripiega su un file .data/store.json, solo per provare.
import fs from 'node:fs/promises';
import path from 'node:path';

const PG_KEY = 'mm:pgs';
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const FILE = path.join(process.cwd(), '.data', 'store.json');

export function storeKind() {
  if (REDIS_URL && REDIS_TOKEN) return 'redis';
  return process.env.VERCEL ? 'none' : 'file';
}

async function redis(command) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || 'redis ' + r.status);
  return j.result;
}

async function readFile() {
  try {
    const data = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return { h: data.h || {}, k: data.k || {} };
  } catch {
    return { h: {}, k: {} };
  }
}

async function writeFile(data) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(data));
}

// ---- hash: campo -> stringa ----
export async function hGetAll(key) {
  if (storeKind() === 'redis') {
    const flat = (await redis(['HGETALL', key])) || [];
    const all = {};
    for (let n = 0; n < flat.length; n += 2) all[flat[n]] = flat[n + 1];
    return all;
  }
  const data = await readFile();
  return data.h[key] || {};
}

export async function hGet(key, field) {
  if (storeKind() === 'redis') return (await redis(['HGET', key, field])) || null;
  const data = await readFile();
  return (data.h[key] && data.h[key][field]) || null;
}

export async function hSet(key, field, value) {
  if (storeKind() === 'redis') {
    await redis(['HSET', key, field, value]);
    return;
  }
  const data = await readFile();
  data.h[key] = data.h[key] || {};
  data.h[key][field] = value;
  await writeFile(data);
}

export async function hDel(key, field) {
  if (storeKind() === 'redis') {
    await redis(['HDEL', key, field]);
    return;
  }
  const data = await readFile();
  if (data.h[key]) delete data.h[key][field];
  await writeFile(data);
}

// ---- chiave semplice: stringa ----
export async function kGet(key) {
  if (storeKind() === 'redis') return (await redis(['GET', key])) || null;
  const data = await readFile();
  return data.k[key] || null;
}

export async function kSet(key, value) {
  if (storeKind() === 'redis') {
    await redis(['SET', key, value]);
    return;
  }
  const data = await readFile();
  data.k[key] = value;
  await writeFile(data);
}

// ---- PG ufficiali (record JSON) ----
export async function getAll() {
  const raw = await hGetAll(PG_KEY);
  const all = {};
  for (const [id, value] of Object.entries(raw)) {
    try {
      all[id] = JSON.parse(value);
    } catch {
      /* record illeggibile: ignorato */
    }
  }
  return all;
}

export async function get(id) {
  const raw = await hGet(PG_KEY, id);
  return raw ? JSON.parse(raw) : null;
}

export async function put(id, record) {
  await hSet(PG_KEY, id, JSON.stringify(record));
}

export async function del(id) {
  await hDel(PG_KEY, id);
}
