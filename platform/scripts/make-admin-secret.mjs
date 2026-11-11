#!/usr/bin/env node
// Generates the owner's dashboard password and the two secrets the Worker needs.
// Nothing is written to disk. Store the password in a password manager.
//   node scripts/make-admin-secret.mjs
import { randomBytes, createHash } from 'node:crypto';
const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const password = [...randomBytes(24)].map((b) => alphabet[b % alphabet.length]).join('').replace(/(.{6})(?=.)/g, '$1-');
const salt = randomBytes(16).toString('hex');
const hash = createHash('sha256').update(salt + password).digest('hex');
console.log('Dashboard password (save it now; it is not stored anywhere):\n  ' + password + '\n');
console.log('Set these as Worker secrets (wrangler secret put NAME), or in .dev.vars for local use:');
console.log('  ADMIN_PASSWORD_HASH = sha256$' + salt + '$' + hash);
console.log('  SESSION_SECRET      = ' + randomBytes(32).toString('hex'));
console.log('  WEBHOOK_SECRET      = ' + randomBytes(24).toString('hex'));
