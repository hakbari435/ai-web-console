// سرور اصلی: Express + REST (مطابق نسخه‌ی مرجع) + یک WebSocket سراسری
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import * as config from './config.js';
import * as sessionStore from './sessionStore.js';
import * as modelsStore from './modelsStore.js';
import * as overrides from './overridesStore.js';
import { getCatalog, getDefaults } from './codexCatalog.js';
import * as discovery from './discovery.js';
import { allGoals, getGoal } from './goals.js';
import { searchTranscripts } from './transcriptSearch.js';
import { Manager, ADAPTERS } from './manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const STATIC_DIR = path.join(root, 'public');

const app = express();
app.use(express.json());
// ابزار dev محلی — کش نشود تا تغییرات UI با رفرش بیاید
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.use('/static', express.static(STATIC_DIR));
app.use('/vendor/fontsource', express.static(
  path.join(root, 'node_modules', '@fontsource', 'vazirmatn')));
app.get('/', (_req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));

// ---- پیکربندی ----
app.get('/api/config', (_req, res) => {
  res.json({ clis: config.configuredClis(), workdir: config.WORKDIR });
});

// ---- انتخاب پوشه با دیالوگ بومی ویندوز ----
app.post('/api/browse-directory', (_req, res) => {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = 'انتخاب پوشه‌ی پروژه'",
    "$d.SelectedPath = '" + String(config.WORKDIR).replace(/'/g, "''") + "'",
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
  ].join('; ');
  const proc = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    windowsHide: true,
  });
  let out = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (c) => { out += c; });
  proc.on('error', () => res.status(500).json({ error: 'انتخاب‌گر پوشه در دسترس نیست' }));
  proc.on('close', (code) => {
    const p = out.trim();
    if (code === 0 && p) res.json({ path: p });
    else res.json({ path: '' });
  });
});

// ---- مدل‌ها ----
const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

async function modelsPayload(forceRefresh = false) {
  const configured = modelsStore.getAll();
  const catalog = await getCatalog(forceRefresh);
  let cat = catalog;
  if (catalog.models && catalog.models.length) {
    configured.codex = catalog.models.map((m) => m.id);
  } else {
    cat = {
      ...catalog,
      models: configured.codex.map((id) => ({
        id, display_name: id, description: '', is_default: false, default_effort: null, efforts: [],
      })),
    };
  }
  configured._catalog = { codex: cat };
  return configured;
}

app.get('/api/models', async (req, res) => {
  res.json(await modelsPayload(req.query.refresh === 'true'));
});

app.put('/api/models/:cli', async (req, res) => {
  if (!ADAPTERS[req.params.cli]) return res.status(400).json({ error: 'unknown cli' });
  modelsStore.setCli(req.params.cli, req.body.models || []);
  res.json(await modelsPayload());
});

app.get('/api/codex/defaults', async (req, res) => {
  const cwd = String(req.query.cwd || '').replace(/^~(?=$|[\\/])/, config.WORKDIR);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return res.status(400).json({ error: `پوشه پیدا نشد: ${cwd}` });
  }
  res.json(await getDefaults(cwd, req.query.refresh === 'true'));
});

// ---- جستجو ----
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const { scope = 'all', project = '', session_id: sessionId = '' } = req.query;
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 200));
  if (q.length < 2) return res.status(400).json({ error: 'query must contain at least 2 characters' });
  if (!['all', 'project', 'session'].includes(scope)) {
    return res.status(400).json({ error: 'invalid scope' });
  }
  if (scope === 'project' && !project) return res.status(400).json({ error: 'project is required' });
  if (scope === 'session' && !sessionId) return res.status(400).json({ error: 'session_id is required' });

  const payload = searchTranscripts(q, { scope, project, sessionId, limit });
  for (const result of payload.results) {
    result.title = overrides.getName(result.cli, result.session_id) || result.title;
  }
  res.json(payload);
});

// ---- سشن‌های روی دیسک ----
app.get('/api/sessions', (req, res) => {
  const sessions = discovery.listSessions(req.query.cli || 'all', Number(req.query.limit) || 0);
  const names = overrides.allNames();
  const conversations = new Map(
    sessionStore.listConversations()
      .filter((c) => c.session_id)
      .map((c) => [`${c.cli}:${c.session_id}`, c]),
  );
  const gmap = allGoals();
  for (const s of sessions) {
    const name = names[`${s.cli}:${s.session_id}`];
    if (name) s.title = name;
    else {
      const conv = conversations.get(`${s.cli}:${s.session_id}`);
      if (conv && conv.title) s.title = conv.title;
    }
    if (s.cli === 'codex') {
      const g = gmap[s.session_id];
      if (g) {
        s.goal_status = g.status;
        s.goal = g.objective;
      }
    }
  }
  res.json(sessions);
});

app.put('/api/sessions/:cli/:session_id/name', (req, res) => {
  const name = String(req.body.name || '').trim();
  overrides.setName(req.params.cli, req.params.session_id, name);
  const conv = sessionStore.findBySession(req.params.cli, req.params.session_id);
  if (conv) {
    let title = name;
    if (!title) {
      const meta = discovery.sessionMeta(req.params.cli, req.params.session_id);
      title = (meta && meta.title) || conv.title;
    }
    if (title) sessionStore.update(conv.id, { title });
  }
  res.json({ ok: true, name: overrides.getName(req.params.cli, req.params.session_id) });
});

app.post('/api/sessions/:cli/:session_id/fork', (req, res) => {
  const { cli, session_id: sessionId } = req.params;
  if (!ADAPTERS[cli]) return res.status(400).json({ error: 'unknown cli' });

  const sourceConv = sessionStore.findBySession(cli, sessionId);
  if (sourceConv && manager.isBusy(sourceConv.id)) {
    return res.status(409).json({ error: 'این سشن در حال اجراست؛ بعد از پایان نوبت دوباره تلاش کنید.' });
  }

  const meta = discovery.sessionMeta(cli, sessionId);
  if (!meta) return res.status(404).json({ error: 'session not found' });

  const messageIndex = req.body.message_index;
  let forkPt = null;
  if (messageIndex !== undefined && messageIndex !== null) {
    forkPt = discovery.forkPoint(cli, sessionId, messageIndex);
    if (!forkPt) return res.status(400).json({ error: 'پاسخ انتخاب‌شده معتبر نیست.' });
  }

  const copied = discovery.forkSession(cli, sessionId, forkPt ? forkPt.cutoff_line : null);
  if (!copied) return res.status(500).json({ error: 'fork failed' });

  const sourceTitle = overrides.getName(cli, sessionId) ||
    (sourceConv ? sourceConv.title : null) || meta.title || 'گفتگو';
  const suffix = forkPt ? `کپی تا پاسخ ${forkPt.reply_number}` : 'کپی';
  const title = `${sourceTitle} (${suffix})`;
  const conv = sessionStore.create({
    cli,
    title,
    cwd: meta.cwd,
    sessionId: copied.session_id,
    imported: true,
    model: sourceConv ? sourceConv.model : null,
    reasoningEffort: sourceConv ? sourceConv.reasoning_effort : null,
  });
  overrides.setName(cli, copied.session_id, title);
  res.json({ ...conv, title });
});

app.delete('/api/sessions/:cli/:session_id', (req, res) => {
  const ok = discovery.deleteSession(req.params.cli, req.params.session_id);
  sessionStore.deleteBySession(req.params.cli, req.params.session_id);
  overrides.removeName(req.params.cli, req.params.session_id);
  res.json({ ok });
});

// ---- گفتگوها ----
app.get('/api/conversations', (_req, res) => {
  const conversations = sessionStore.listConversations();
  for (const conv of conversations) {
    if (conv.session_id) {
      const name = overrides.getName(conv.cli, conv.session_id);
      if (name) conv.title = name;
    }
  }
  res.json(conversations);
});

app.post('/api/conversations', (req, res) => {
  const cli = req.body.cli || 'codex';
  if (!ADAPTERS[cli]) return res.status(400).json({ error: 'unknown cli' });
  let cwd = req.body.cwd || null;
  if (cwd) {
    cwd = path.resolve(String(cwd).replace(/^~(?=$|[\\/])/, config.WORKDIR));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return res.status(400).json({ error: `پوشه پیدا نشد: ${cwd}` });
    }
  }
  const effort = req.body.reasoning_effort;
  if (effort !== null && effort !== undefined && effort !== '' &&
      !REASONING_EFFORTS.has(String(effort))) {
    return res.status(400).json({ error: 'invalid reasoning effort' });
  }
  let title = req.body.title;
  if (title !== null && title !== undefined) title = String(title).trim() || null;
  res.json(sessionStore.create({
    cli, title, cwd,
    model: req.body.model || null,
    reasoningEffort: cli === 'codex' ? (effort || null) : null,
  }));
});

app.post('/api/conversations/import', (req, res) => {
  const { cli, session_id: sid } = req.body;
  if (!ADAPTERS[cli] || !sid) return res.status(400).json({ error: 'cli and session_id required' });
  const existing = sessionStore.findBySession(cli, sid);
  if (existing) return res.json(existing);
  const meta = discovery.sessionMeta(cli, sid);
  if (!meta) return res.status(404).json({ error: 'session not found' });
  res.json(sessionStore.create({
    cli,
    title: overrides.getName(cli, sid) || meta.title,
    cwd: meta.cwd,
    sessionId: sid,
    imported: true,
  }));
});

app.get('/api/conversations/:cid', (req, res) => {
  const conv = sessionStore.get(req.params.cid);
  if (!conv) return res.status(404).json({ error: 'not found' });
  const busy = manager.isBusy(conv.id);
  const limit = Number(req.query.limit ?? 50);

  let messages = [];
  if (busy && manager.preHistory.has(conv.id)) {
    // وسط نوبت: نوبت‌های قبلی از snapshot؛ نوبت زنده از WS می‌آید
    messages = manager.preHistory.get(conv.id);
  } else if (conv.session_id) {
    // خواندن تازه از فایل سشن خود CLI تا تغییرات از ترمینال دیگر هم دیده شود
    const [msgs] = discovery.readTranscript(conv.cli, conv.session_id);
    messages = msgs || [];
  }

  const total = messages.length;
  let truncated = false;
  if (limit > 0 && total > limit) {
    messages = messages.slice(-limit);
    truncated = true;
  }

  let title = conv.title;
  let goal = null;
  let usage = null;
  if (conv.session_id) {
    const name = overrides.getName(conv.cli, conv.session_id);
    if (name) title = name;
    if (conv.cli === 'codex') goal = getGoal(conv.session_id);
    usage = discovery.usageMeta(conv.cli, conv.session_id);
  }
  const publicMessages = messages.map((m) => {
    const out = {};
    for (const [k, v] of Object.entries(m)) if (!k.startsWith('_')) out[k] = v;
    return out;
  });
  res.json({
    ...conv, title, goal, usage, messages: publicMessages,
    total, truncated, busy,
  });
});

function localMessageDate(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === '') return null;
  let value = timestamp;
  try {
    if (typeof value === 'number') {
      const seconds = Math.abs(value) >= 1e12 ? value / 1000 : value;
      const d = new Date(seconds * 1000);
      return localDayKey(d);
    }
    const d = new Date(String(value).endsWith('Z') ? value : String(value));
    if (Number.isNaN(d.getTime())) return null;
    return localDayKey(d);
  } catch { return null; }
}

function localDayKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

app.get('/api/conversations/:cid/stats', (req, res) => {
  const conv = sessionStore.get(req.params.cid);
  if (!conv) return res.status(404).json({ error: 'not found' });

  let messages = [];
  if (manager.isBusy(req.params.cid) && manager.preHistory.has(req.params.cid)) {
    messages = manager.preHistory.get(req.params.cid);
  } else if (conv.session_id) {
    const [msgs] = discovery.readTranscript(conv.cli, conv.session_id);
    messages = msgs || [];
  }

  const counts = new Map();
  let undated = 0;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const date = localMessageDate(message.timestamp);
    if (date) counts.set(date, (counts.get(date) || 0) + 1);
    else undated++;
  }
  const days = [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, turns]) => ({ date, turns }));
  res.json({
    total_turns: [...counts.values()].reduce((a, b) => a + b, 0) + undated,
    active_days: counts.size,
    days,
    undated_turns: undated,
  });
});

app.patch('/api/conversations/:cid', (req, res) => {
  const fields = {};
  for (const k of ['title', 'model']) {
    if (k in req.body) fields[k] = req.body[k];
  }
  if ('reasoning_effort' in req.body) {
    const v = req.body.reasoning_effort;
    if (v !== null && v !== '' && !REASONING_EFFORTS.has(String(v))) {
      return res.status(400).json({ error: 'invalid reasoning effort' });
    }
    fields.reasoning_effort = v || null;
  }
  const conv = sessionStore.update(req.params.cid, fields);
  if (!conv) return res.status(404).json({ error: 'not found' });
  res.json(conv);
});

app.post('/api/conversations/:cid/read', (req, res) => {
  const conv = manager.markRead(req.params.cid);
  if (!conv) return res.status(404).json({ error: 'not found' });
  manager.toAll({ type: 'attention', cid: req.params.cid, needs_attention: false });
  res.json({ ok: true, needs_attention: false });
});

app.delete('/api/conversations/:cid', (req, res) => {
  sessionStore.remove(req.params.cid);
  res.json({ ok: true });
});

// ---- WebSocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const manager = new Manager();

function originAllowed(origin, host) {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch { return false; }
}

wss.on('connection', (ws, req) => {
  if (!originAllowed(req.headers.origin, req.headers.host)) {
    ws.close(1008);
    return;
  }
  manager.addClient(ws);
  ws.send(JSON.stringify({ type: 'init-status', busy: manager.busyIds() }));

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    const { type, cid } = data;
    if (!cid) return;
    switch (type) {
      case 'open': manager.subscribe(ws, cid); break;
      case 'close': manager.unsubscribe(ws, cid); break;
      case 'message': manager.startTurn(cid, data.text || ''); break;
      case 'stop': manager.stopTurn(cid); break;
      case 'queue_remove': manager.queueRemove(cid, data.index); break;
      case 'queue_edit': manager.queueEdit(cid, data.index, data.text || ''); break;
    }
  });
});

server.listen(config.PORT, config.HOST, () => {
  console.log(`✅ کنسول وب AI روشن شد:  http://${config.HOST}:${config.PORT}`);
  console.log('برای توقف: Ctrl+C');
});

const shutdown = () => {
  for (const cid of [...manager.running]) manager.stopTurn(cid);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
