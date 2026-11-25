import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)),
  runtime = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const cloudModels = process.argv.includes('--cloud-models');
if (cloudModels) {
  const vars = path.join(root, '.dev.vars');
  if (!existsSync(vars))
    throw Error('Set a dedicated DASHSCOPE_API_KEY in .dev.vars for --cloud-models.');
  process.loadEnvFile(vars);
  if (!process.env.DASHSCOPE_API_KEY)
    throw Error('DASHSCOPE_API_KEY is required for --cloud-models.');
}
const port = Number(process.env.LEARN_PORT || 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid LEARN_PORT');
mkdirSync(path.join(root, '.local'), { recursive: true });
const key = randomBytes(24).toString('hex'),
  origin = 'http://127.0.0.1:' + port;
const env = {
  ...process.env,
  WRANGLER_LOG_PATH: path.join(root, '.local/wrangler.log'),
  WRANGLER_SEND_METRICS: 'false',
  CLOUDFLARE_CF_FETCH_ENABLED: 'false',
  LOCAL_RENDER_KEY: key,
  PYTHONUTF8: '1',
  NO_COLOR: '1',
};
const py = env.LEARN_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
for (const [program, args] of [
  [py, ['-c', 'import PIL,requests,websocket']],
  ['ffmpeg', ['-version']],
  ['ffprobe', ['-version']],
]) {
  if (spawnSync(program, args, { env, windowsHide: true, stdio: 'ignore' }).status !== 0) {
    console.error('Missing renderer dependency: ' + program + '. See README.md.');
    process.exit(1);
  }
}
const init = spawnSync(process.execPath, [runtime, 'd1', 'migrations', 'apply', 'DB', '--local'], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true,
});
if (init.status !== 0) process.exit(1);
if (cloudModels) {
  const budget = spawnSync(
    process.execPath,
    [
      runtime,
      'd1',
      'execute',
      'DB',
      '--local',
      '--command',
      'UPDATE cost_budget SET cap_fen=MIN(cap_fen,500) WHERE id=1',
    ],
    { cwd: root, env, stdio: 'inherit', windowsHide: true },
  );
  if (budget.status !== 0) process.exit(1);
}
const site = spawn(
  process.execPath,
  [
    runtime,
    'dev',
    '--local',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--var',
    'LOCAL_DEMO:1',
    '--var',
    'LOCAL_RENDER_KEY:' + key,
    '--var',
    'LOCAL_CLOUD_MODELS:' + (cloudModels ? '1' : '0'),
    '--var',
    'ADMIN_EMAILS:admin@classroom.test',
    '--show-interactive-dev-session=false',
  ],
  { cwd: root, env, stdio: 'inherit', windowsHide: true },
);
const renderer = spawn(
  py,
  ['renderer/service.py', '--local', origin, ...(cloudModels ? ['--cloud-models'] : [])],
  { cwd: root, env, stdio: 'inherit', windowsHide: true },
);
console.log('AI 视频课堂 ' + origin + ' | 本机邀请码 CLASSROOM');
let closing = false;
function stop(code) {
  if (closing) return;
  closing = true;
  renderer.kill();
  site.kill();
  process.exitCode = code;
}
site.once('exit', (n) => stop(n || 0));
renderer.once('exit', (n) => stop(n || 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
