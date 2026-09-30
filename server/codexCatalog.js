// کشف کاتالوگ مدل‌های Codex از طریق app-server رسمی (JSON-RPC روی stdio)
import { spawn } from 'node:child_process';
import { codexCommand, codexEnv, CODEX_EXEC_PREFIX_ARGS, CODEX_EXTRA_ARGS, CODEX_MODEL, splitArgs } from './config.js';

const CACHE_TTL_MS = 300_000;
let cache = null;
let cacheTime = 0;
let inflight = null;
const defaultsCache = new Map();

function normalize(result) {
  const models = [];
  for (const raw of result.data || []) {
    const modelId = String(raw.id ?? raw.model ?? '').trim();
    if (!modelId || raw.hidden) continue;
    const efforts = [];
    for (const item of raw.supportedReasoningEfforts || []) {
      const effort = String(item.reasoningEffort ?? '').trim();
      if (effort) {
        efforts.push({ id: effort, description: String(item.description ?? '').trim() });
      }
    }
    models.push({
      id: modelId,
      display_name: String(raw.displayName ?? modelId).trim(),
      description: String(raw.description ?? '').trim(),
      is_default: Boolean(raw.isDefault),
      default_effort: raw.defaultReasoningEffort ?? null,
      efforts,
    });
  }
  return models;
}

function request(method, params) {
  return new Promise((resolve, reject) => {
    const argv = codexCommand(['app-server', '--listen', 'stdio://']);
    const proc = spawn(argv[0], argv.slice(1), {
      env: codexEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const requests = [
      { method: 'initialize', id: 0, params: { clientInfo: { name: 'ai_web_console', title: 'AI Web Console', version: '1.0.0' } } },
      { method: 'initialized', params: {} },
      { method, id: 1, params },
    ];
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error('Codex model discovery timed out'));
    }, 15000);

    function finish(err, response) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.stdin.end(); } catch { /* بی‌اهمیت */ }
      try { proc.kill(); } catch { /* بی‌اهمیت */ }
      if (err) reject(err);
      else if (response && response.error) {
        const e = response.error;
        reject(new Error(String((e && typeof e === 'object' && e.message) || e)));
      } else resolve((response && response.result) || {});
    }

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) { finish(null, message); return; }
      }
    });
    proc.on('error', (err) => finish(err));
    proc.on('exit', () => finish(new Error('codex app-server exited early')));

    for (const item of requests) proc.stdin.write(JSON.stringify(item) + '\n');
  });
}

async function query() {
  const result = await request('model/list', { limit: 100, includeHidden: false });
  const models = normalize(result);
  if (!models.length) throw new Error('Codex returned an empty model catalog');
  return { source: 'codex', models, error: null };
}

export async function getCatalog(force = false) {
  const now = Date.now();
  if (!force && cache && now - cacheTime < CACHE_TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const catalog = await query();
      cache = catalog;
      cacheTime = Date.now();
      return catalog;
    } catch (err) {
      const error = String(err.message || err).slice(0, 500);
      if (cache) return { ...cache, error, stale: true };
      return { source: 'fallback', models: [], error };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// مدل‌های پیش‌فرض بر اساس فلگ‌های اضافی لانچر
function extraDefaults() {
  const tokens = [...splitArgs(CODEX_EXEC_PREFIX_ARGS), ...splitArgs(CODEX_EXTRA_ARGS)];
  const values = {};
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if ((token === '-m' || token === '--model') && i + 1 < tokens.length) {
      values.model = tokens[i + 1];
      i += 2;
      continue;
    }
    let assignment = null;
    if ((token === '-c' || token === '--config') && i + 1 < tokens.length) {
      assignment = tokens[i + 1];
      i += 2;
    } else if (token.startsWith('--config=')) {
      assignment = token.split('=').slice(1).join('=');
      i += 1;
    } else {
      i += 1;
      continue;
    }
    const eq = assignment.indexOf('=');
    if (eq > 0) {
      const key = assignment.slice(0, eq);
      if (key === 'model' || key === 'model_reasoning_effort') {
        values[key] = assignment.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  if (CODEX_MODEL) values.model = CODEX_MODEL;
  return values;
}

export async function getDefaults(cwd, force = false) {
  const key = String(cwd).toLowerCase();
  const now = Date.now();
  const cached = defaultsCache.get(key);
  if (!force && cached && now - cached.time < CACHE_TTL_MS) return cached.payload;
  try {
    const result = await request('config/read', { cwd, includeLayers: false });
    const effective = result.config || result;
    const overrides = extraDefaults();
    let model = overrides.model || effective.model || null;
    let effort = overrides.model_reasoning_effort || effective.model_reasoning_effort || null;
    const catalog = await getCatalog();
    const defaultModel = catalog.models.find((m) => m.is_default) || null;
    model = model || (defaultModel && defaultModel.id) || null;
    const modelInfo = catalog.models.find((m) => m.id === model) || defaultModel;
    effort = effort || (modelInfo && modelInfo.default_effort) || null;
    const payload = { source: 'codex', cwd: key, model, reasoning_effort: effort, error: null };
    defaultsCache.set(key, { time: Date.now(), payload });
    return payload;
  } catch (err) {
    const catalog = await getCatalog();
    const defaultModel = catalog.models.find((m) => m.is_default) || null;
    return {
      source: 'fallback',
      cwd: key,
      model: defaultModel && defaultModel.id,
      reasoning_effort: defaultModel && defaultModel.default_effort,
      error: String(err.message || err).slice(0, 500),
    };
  }
}
