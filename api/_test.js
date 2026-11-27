// Area di prova (sviluppo): si entra con la password master e si riceve un "pass" firmato che vale 7 giorni.
// Il pass non è salvato da nessuna parte: si controlla ricalcolando la firma, quindi non consuma il database
// e decade da solo se cambia la password master.
import crypto from 'node:crypto';

const DAYS = 7;

const sign = (master, exp) => crypto.createHmac('sha256', master).update('mm-test:' + exp).digest('hex');

export function isMaster(password) {
  const master = process.env.GM_PASSWORD;
  if (!master) return false;
  const a = crypto.createHash('sha256').update(String(password || '')).digest();
  const b = crypto.createHash('sha256').update(master).digest();
  return crypto.timingSafeEqual(a, b);
}

export function makeTestPass() {
  const exp = Date.now() + DAYS * 86_400_000;
  return 'mmt.' + exp + '.' + sign(process.env.GM_PASSWORD, exp);
}

export function validTestPass(pass) {
  const master = process.env.GM_PASSWORD;
  const [tag, exp, mac] = String(pass || '').split('.');
  if (!master || tag !== 'mmt' || !/^\d{10,16}$/.test(exp || '') || Number(exp) < Date.now()) return false;
  const a = Buffer.from(String(mac || ''));
  const b = Buffer.from(sign(master, exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
