// پیکربندی — از متغیرهای محیطی و فایل .env کنار پروژه (بدون وابستگی خارجی)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASE_DIR = path.resolve(__dirname, '..');

// پارسر ساده‌ی .env (KEY=VALUE، بدون نیاز به dotenv)
const ENV_PATH = path.join(BASE_DIR, '.env');
const dotenv = {};
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function get(key, defaultValue = null) {
  if (process.env[key]) return process.env[key];
  const v = dotenv[key];
  return v !== undefined && v !== '' ? v : defaultValue;
}
const flag = (key, dflt = '0') =>
  String(get(key, dflt)).trim().toLowerCase() in { 1: 1, true: 1, yes: 1, on: 1 };

// --- سرور (فقط localhost) ---
export const HOST = get('HOST', '127.0.0.1');
export const PORT = Number(get('PORT', '3000'));

// پوشه‌ی کاری پیش‌فرض CLI ها
export const WORKDIR = get('WORKDIR', os.homedir()) || os.homedir();

// --- Claude ---
export const CLAUDE_CMD = get('CLAUDE_CMD', 'claude');
export const CLAUDE_MODEL = get('CLAUDE_MODEL', '');
export const CLAUDE_PERMISSION_MODE = get('CLAUDE_PERMISSION_MODE', 'acceptEdits');
export const CLAUDE_EXTRA_ARGS = get('CLAUDE_EXTRA_ARGS', '');
// پیش‌فرض: بدون رد کردن دسترسی‌ها (بر خلاف نسخه‌ی مرجع؛ با 1 فعال می‌شود)
export const CLAUDE_SKIP_PERMISSIONS = flag('CLAUDE_SKIP_PERMISSIONS', '0');
export const CLAUDE_CONTEXT_WINDOW = Number(get('CLAUDE_CONTEXT_WINDOW', '200000'));

// --- Codex ---
export const CODEX_CMD = get('CODEX_CMD', 'codex');
export const CODEX_HOME = get('CODEX_HOME', path.join(os.homedir(), '.codex'));

// mirror کردن لانچر سفارشی (مثل codexx = «codex -c model_provider=proxy --search»)
// وقتی پرووایدر proxy در config.toml تعریف شده باشد (بدون دست زدن به خود فایل).
function codexExecPrefixFromConfig(codexHome) {
  let toml;
  try {
    toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  } catch { return ''; }

  if (!/^\s*\[model_providers\.proxy\]/m.test(toml)) return '';

  // top-level model_provider (خارج از هر [section])
  const sectionSpans = [...toml.matchAll(/^\s*\[[^\]]+\]\s*$/gm)];
  const topLevel = sectionSpans.length
    ? toml.slice(0, sectionSpans[0].index)
    : toml;
  const selected = topLevel.match(/^\s*model_provider\s*=\s*["']([^"']+)["']/m);
  if (selected && !['', 'proxy'].includes(selected[1])) return '';

  // بخش proxy: اگر هیچ سازوکار احراز هویتی ندارد، هدر را هم اضافه کن (مطابق مرجع)
  const proxyMatch = toml.match(/^\s*\[model_providers\.proxy\]\s*$/m);
  const nextSection = toml.slice(proxyMatch.index + proxyMatch[0].length).search(/^\s*\[/m);
  const proxyBody = nextSection === -1
    ? toml.slice(proxyMatch.index + proxyMatch[0].length)
    : toml.slice(proxyMatch.index + proxyMatch[0].length, proxyMatch.index + proxyMatch[0].length + nextSection);

  const args = [];
  if (!selected) args.push('-c', 'model_provider=proxy');
  const hasAuth = /experimental_bearer_token|http_headers/.test(proxyBody);
  if (!hasAuth) {
    args.push('-c', 'model_providers.proxy.http_headers={ "x-openai-actor-authorization" = "enabled" }');
  }
  args.push('--search');
  return args.join(' ');
}

export const CODEX_EXEC_PREFIX_ARGS = get('CODEX_EXEC_PREFIX_ARGS', codexExecPrefixFromConfig(CODEX_HOME));
export const CODEX_SHELL_WRAP = get('CODEX_SHELL_WRAP', '');
export const CODEX_SANDBOX = get('CODEX_SANDBOX', 'workspace-write');
export const CODEX_EXTRA_ARGS = get('CODEX_EXTRA_ARGS', '');
export const CODEX_BYPASS = flag('CODEX_BYPASS', '0');
export const CODEX_MODEL = get('CODEX_MODEL', '');

// فهرست مدل‌های پیش‌فرض (وقتی کشف زنده در دسترس نیست)
export const CLAUDE_MODELS = get('CLAUDE_MODELS', 'opus,sonnet,haiku');
export const CODEX_MODELS = get('CODEX_MODELS', 'gpt-5-codex,gpt-5,o3');

// کلیدهایی که از .env به پروسه‌ی Claude پاس می‌شوند
const CLAUDE_ONLY_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_'];
const CLAUDE_ENV_PREFIXES = [...CLAUDE_ONLY_PREFIXES, 'AWS_', 'CLOUD_ML_'];

function mergeDotenv(env, include) {
  for (const [key, val] of Object.entries(dotenv)) {
    if (val !== null && val !== undefined && include(key)) {
      if (!(key in env)) env[key] = val;
    }
  }
  return env;
}

export function claudeEnv() {
  return mergeDotenv({ ...process.env }, (k) => CLAUDE_ENV_PREFIXES.some((p) => k.startsWith(p)));
}

export function codexEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!CLAUDE_ONLY_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
  }
  if (!(('CODEX_HOME') in env)) env.CODEX_HOME = CODEX_HOME;
  return mergeDotenv(env, (k) => !CLAUDE_ONLY_PREFIXES.some((p) => k.startsWith(p)));
}

export function configuredClis() {
  const claudeReady = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
    .some((key) => get(key));
  return [
    { id: 'claude', label: 'Claude', configured: claudeReady },
    { id: 'codex', label: 'Codex', configured: true },
  ];
}

// ساخت دستور codex با حفظ ترتیب prefix/subcommand (مطابق نسخه‌ی مرجع)
export function codexCommand(args, prefixArgs = CODEX_EXEC_PREFIX_ARGS) {
  const full = [CODEX_CMD, ...splitArgs(prefixArgs), ...args];
  const wrap = String(CODEX_SHELL_WRAP).trim();
  if (!wrap) return full;
  const command = full.map(shellQuote).join(' ');
  return [...splitArgs(wrap), command];
}

// پارسر سبک shlex برای آرگومان‌های پیشوندی
export function splitArgs(s) {
  if (!s) return [];
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < String(s).length; i++) {
    const c = String(s)[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } }
    else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `"${value.replace(/(["$`\\])/g, '\\$1')}"`;
}
