// Create the first admin account, or add another from the command line.
//
//   node scripts/create-admin.mjs
//
// The password is typed at a hidden prompt. It is never passed as an argument,
// because arguments end up in shell history and in the process list.

import { readFileSync } from 'fs';
import { createRequire } from 'module';
import readline from 'readline';

const require = createRequire(import.meta.url);

for (const f of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n]+)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const { neon } = require('@neondatabase/serverless');
const A = require('../api/_auth.js');
const sql = neon(process.env.DATABASE_URL);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

/** Prompt without echoing, so the password never appears on screen. */
function askHidden(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    let value = '';
    const onData = (chunk) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\n' || ch === '\r' || ch === '') {
          if (stdin.isTTY) stdin.setRawMode(wasRaw);
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '') { process.stdout.write('\n'); process.exit(1); }
        if (ch === '' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

try {
  const existing = await sql`SELECT count(*)::int AS n FROM admin_users`;
  console.log(`\nBelvoir admin accounts: ${existing[0].n}\n`);

  const email = (await ask('Email:    ')).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('\nThat email address does not look right.');
    process.exit(1);
  }
  const dupe = await sql`SELECT 1 FROM admin_users WHERE lower(email) = ${email} LIMIT 1`;
  if (dupe.length) {
    console.error('\nThat email already has an account.');
    process.exit(1);
  }

  const name = (await ask('Name:     ')).trim();
  rl.pause();

  const password = await askHidden('Password: ');
  const problem = A.passwordProblem(password);
  if (problem) {
    console.error('\n' + problem);
    process.exit(1);
  }
  const again = await askHidden('Confirm:  ');
  if (again !== password) {
    console.error('\nThose two passwords do not match.');
    process.exit(1);
  }

  const role = existing[0].n === 0 ? 'owner' : 'manager';
  const rows = await sql`
    INSERT INTO admin_users (email, password_hash, name, role)
    VALUES (${email}, ${await A.hashPassword(password)}, ${name || email}, ${role})
    RETURNING id, email, name, role`;

  console.log(`\n  created ${rows[0].email}  (${rows[0].role})`);
  console.log('  sign in at https://www.belvoir-estates.com/admin\n');
} finally {
  rl.close();
  process.exit(0);
}
