// Archivio dei PG ufficiali.
// In produzione usa Redis (Upstash, collegato da Vercel → Storage): le variabili
// KV_REST_API_URL / KV_REST_API_TOKEN (o UPSTASH_REDIS_REST_URL / _TOKEN) vengono create da Vercel.
// In locale (npm run dev) ripiega su un file .data/pgs.json, solo per provare.
import fs from 'node:fs/promises';
import path from 'node:path';

const KEY = 'mm:pgs';
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const FILE = path.join(process.cwd(), '.data', 'pgs.json');

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
    return JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeFile(all) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(all));
}

export async function getAll() {
  if (storeKind() === 'redis') {
    const flat = (await redis(['HGETALL', KEY])) || [];
    const all = {};
    for (let k = 0; k < flat.length; k += 2) {
      try {
        all[flat[k]] = JSON.parse(flat[k + 1]);
      } catch {
        /* record illeggibile: ignorato */
      }
    }
    return all;
  }
  return readFile();
}

export async function get(id) {
  if (storeKind() === 'redis') {
    const raw = await redis(['HGET', KEY, id]);
    return raw ? JSON.parse(raw) : null;
  }
  const all = await readFile();
  return all[id] || null;
}

export async function put(id, record) {
  if (storeKind() === 'redis') {
    await redis(['HSET', KEY, id, JSON.stringify(record)]);
    return;
  }
  const all = await readFile();
  all[id] = record;
  await writeFile(all);
}

export async function del(id) {
  if (storeKind() === 'redis') {
    await redis(['HDEL', KEY, id]);
    return;
  }
  const all = await readFile();
  delete all[id];
  await writeFile(all);
}
