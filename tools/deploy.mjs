import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const db = process.env.LEARN_D1_ID;
if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(db || '') || db.startsWith('00000000'))
  throw Error('Set LEARN_D1_ID to the dedicated classroom database ID.');
const cfg = JSON.parse(readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
cfg.d1_databases[0].database_id = db;
cfg.routes = [{ pattern: 'learn.hachile.org', custom_domain: true }];
const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== '--public-preview')) throw Error('Unknown deployment option');
if (flags.includes('--public-preview')) {
  cfg.vars.PUBLIC_PREVIEW = '1';
  delete cfg.r2_buckets;
  cfg.triggers = { crons: [] };
}
for (const name of [
  'ACCESS_MODE',
  'PAYMENT_MODE',
  'FC_ENDPOINT',
  'FC_FUNCTION',
  'MAIL_FROM',
  'ADMIN_EMAILS',
  'QWEN_BASE',
  'QWEN_MODEL',
]) {
  if (process.env[name]) cfg.vars[name] = process.env[name];
}
if (!['live', 'sandbox'].includes(cfg.vars.PAYMENT_MODE)) throw Error('Invalid PAYMENT_MODE');
const file = path.join(root, 'wrangler.deploy.local.json');
writeFileSync(file, JSON.stringify(cfg, null, 2), { flag: 'wx' });
try {
  for (const args of [['d1', 'migrations', 'apply', 'DB', '--remote'], ['deploy']]) {
    const r = spawnSync(
      process.execPath,
      [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args, '--config', file],
      { stdio: 'inherit', cwd: root },
    );
    if (r.status !== 0) {
      process.exitCode = 1;
      break;
    }
  }
} finally {
  unlinkSync(file);
}
