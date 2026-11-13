// Test harness: an in-memory SQLite database behind the D1 interface, and a fake env.
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker/index.mjs';
import { hashPassword } from '../src/worker/core.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class Stmt {
  constructor(sqlite, sql, args = []) { this.sqlite = sqlite; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.sqlite, this.sql, args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a))); }
  async first() { return this.sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.sqlite.prepare(this.sql).all(...this.args) }; }
  async run() { const r = this.sqlite.prepare(this.sql).run(...this.args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; }
}
export class FakeD1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys = ON'); this.queries = 0; }
  prepare(sql) { this.queries++; return new Stmt(this.sqlite, sql); }
  async batch(stmts) {
    this.sqlite.exec('BEGIN');
    try { const out = []; for (const s of stmts) out.push(await s.run()); this.sqlite.exec('COMMIT'); return out; }
    catch (e) { this.sqlite.exec('ROLLBACK'); throw e; }
  }
}

export async function makeEnv(overrides = {}) {
  const DB = new FakeD1();
  for (const f of ['0001_init.sql', '0002_send_audience.sql', '0003_placement_tests.sql', '0004_webhook_messages.sql', '0005_engagement.sql', '0006_inbound_checks.sql']) DB.sqlite.exec(await readFile(path.join(ROOT, 'migrations', f), 'utf8'));
  const ASSETS = {
    async fetch(req) {
      const p = new URL(typeof req === 'string' ? req : req.url).pathname;
      try { return new Response(await readFile(path.join(ROOT, 'dist', p.endsWith('/') ? p + 'index.html' : p))); }
      catch { return new Response('not found', { status: 404 }); }
    },
  };
  return { DB, ASSETS, SITE_ENV: 'preview', SITE_URL: 'https://preview.example', SESSION_SECRET: 'test-session-secret', ADMIN_PASSWORD_HASH: await hashPassword('correct horse', 1000),
    WEBHOOK_SECRET: 'hook-secret', EXPOSE_CONFIRM_LINKS: 'true', POSTAL_ADDRESS: '123 Test Street, Oxford, OH 45056', TEST_RECIPIENTS: 'owner-test@example.com', ...overrides };
}

/** Call the Worker like a browser would. Keeps the admin cookie between calls. */
export function client(env) {
  let cookie = '';
  const call = async (method, url, bodyObj, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (cookie) init.headers.cookie = cookie;
    if (bodyObj !== undefined) { init.body = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj); init.headers['content-type'] = init.headers['content-type'] || 'application/json'; }
    const res = await worker.fetch(new Request('https://preview.example' + url, init), env);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (u, h) => call('GET', u, undefined, h), post: (u, b, h) => call('POST', u, b ?? {}, h), patch: (u, b) => call('PATCH', u, b),
    login: () => call('POST', '/api/admin/login', { password: 'correct horse' }),
    dropCookie: () => { cookie = ''; },
  };
}
export const tickAll = async (env, max = 40) => { const { tick } = await import('../src/worker/sending.mjs'); for (let i = 0; i < max; i++) { const r = await tick(env); if (!r.length || r.every((x) => x.done)) return i + 1; } return max; };
