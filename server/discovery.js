// کشف و پارس سشن‌های موجود CLI روی دیسک تا بتوان resume کرد.
//   Claude:  ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
//   Codex:   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// همه‌ی پارسرها defensive اند: محتوا می‌تواند str / لیست بلاک / dict باشد.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CLAUDE_CONTEXT_WINDOW } from './config.js';

export const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
export const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');

const SCAN_LINES = 500;

// ------------------------------------------------------------------ //
//  ابزارهای مشترک
// ------------------------------------------------------------------ //
export function flattenContent(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        parts.push(block.text ?? block.content ?? '');
      } else parts.push(String(block));
    }
    return parts.filter(Boolean).join('\n');
  }
  if (typeof content === 'object') return content.text ?? content.content ?? '';
  return String(content);
}

function loads(line) {
  line = (line || '').trim();
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function safeMtime(fp) {
  try { return fs.statSync(fp).mtimeMs / 1000; } catch { return 0; }
}

function walk(dir, filter, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

// ------------------------------------------------------------------ //
//  فهرست کردن (خلاصه‌ها برای سایدبار)
// ------------------------------------------------------------------ //
export function listSessions(cli = 'all', limit = 0) {
  let out = [];
  if (cli === 'all' || cli === 'claude') out = out.concat(listClaude(limit));
  if (cli === 'all' || cli === 'codex') out = out.concat(listCodex(limit));
  out.sort((a, b) => b.mtime - a.mtime);
  return limit > 0 ? out.slice(0, limit) : out;
}

function summaries(files, parser, limit) {
  const result = [];
  const seen = new Set();
  for (const fp of files) {
    const meta = parser(fp);
    if (!meta) continue;
    if (seen.has(meta.session_id)) continue;
    seen.add(meta.session_id);
    result.push(meta);
    if (limit > 0 && result.length >= limit) break;
  }
  return result;
}

function listClaude(limit) {
  const files = walk(CLAUDE_PROJECTS, (f) => f.endsWith('.jsonl'));
  files.sort((a, b) => safeMtime(b) - safeMtime(a));
  return summaries(files, claudeSummary, limit);
}

function listCodex(limit) {
  const files = walk(CODEX_SESSIONS, (f) => path.basename(f).startsWith('rollout-') && f.endsWith('.jsonl'));
  files.sort((a, b) => safeMtime(b) - safeMtime(a));
  return summaries(files, codexSummary, limit);
}

function userText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && b.type === 'text') return b.text;
    }
  }
  return null;
}

function claudeSummary(fp) {
  const sessionId = path.basename(fp).replace(/\.jsonl$/, '');
  let cwd = null, title = null, firstUser = null;
  try {
    const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/);
    for (let idx = 0; idx < lines.length && idx <= SCAN_LINES; idx++) {
      const obj = loads(lines[idx]);
      if (!obj) continue;
      if (obj.type === 'ai-title' && obj.aiTitle) title = obj.aiTitle;
      if (cwd === null && obj.cwd) cwd = obj.cwd;
      if (firstUser === null && obj.type === 'user') {
        firstUser = userText((obj.message || {}).content);
      }
      if (title && cwd && firstUser) break;
    }
  } catch { return null; }
  if (!title && !firstUser) return null;
  return {
    cli: 'claude',
    session_id: sessionId,
    title: (title || firstUser || 'بدون عنوان').trim().slice(0, 80),
    cwd: cwd || '',
    mtime: safeMtime(fp),
  };
}

function codexMessageText(pl) {
  return flattenContent(pl.content ?? pl.message ?? pl.text);
}

function codexVisibleUser(text) {
  const s = String(text || '').replace(/^\s+/, '');
  return Boolean(s) && !s.startsWith('# AGENTS.md instructions for ') &&
    !s.startsWith('<environment_context>') && !s.startsWith('<permissions instructions>');
}

function codexSummary(fp) {
  let sessionId = null, cwd = null, title = null;
  try {
    const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/);
    for (let idx = 0; idx < lines.length && idx <= SCAN_LINES; idx++) {
      const obj = loads(lines[idx]);
      if (!obj) continue;
      if (obj.type === 'session_meta') {
        const pl = obj.payload || {};
        sessionId = pl.id || sessionId;
        cwd = pl.cwd || cwd;
      }
      const pl = obj.payload || {};
      if (title === null && obj.type === 'event_msg' && pl.type === 'user_message') {
        title = flattenContent(pl.message ?? pl.text);
      }
      if (title === null && obj.type === 'response_item' && pl.type === 'message' && pl.role === 'user') {
        const candidate = codexMessageText(pl);
        if (codexVisibleUser(candidate)) title = candidate;
      }
      if (sessionId && title) break;
    }
  } catch { return null; }
  if (!sessionId) return null;
  return {
    cli: 'codex',
    session_id: sessionId,
    title: (title || 'بدون عنوان').trim().slice(0, 80),
    cwd: cwd || '',
    mtime: safeMtime(fp),
  };
}

// ------------------------------------------------------------------ //
//  پارس کامل ترنسکریپت (تاریخچه برای نمایش در UI)
// ------------------------------------------------------------------ //
export function readTranscript(cli, sessionId) {
  if (cli === 'claude') return claudeTranscript(sessionId);
  if (cli === 'codex') return codexTranscript(sessionId);
  return [null, null];
}

function findClaudeFile(sessionId) {
  return walk(CLAUDE_PROJECTS, (f) => path.basename(f) === `${sessionId}.jsonl`)[0] || null;
}

function findCodexFile(sessionId) {
  const direct = walk(
    CODEX_SESSIONS,
    (f) => path.basename(f).startsWith('rollout-') && f.endsWith(`-${sessionId}.jsonl`),
  );
  if (direct.length) return direct[0];
  // جست‌وجوی وارونه: فایلی که id متای آن با سشن یکی باشد
  for (const fp of walk(CODEX_SESSIONS, (f) => path.basename(f).startsWith('rollout-'))) {
    const first = loads(firstLine(fp));
    if (first && (first.payload || {}).id === sessionId) return fp;
  }
  return null;
}

function firstLine(fp) {
  try {
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8').split(/\r?\n/)[0];
  } catch { return null; }
}

export function sessionMeta(cli, sessionId) {
  if (cli === 'claude') {
    const fp = findClaudeFile(sessionId);
    return fp ? claudeSummary(fp) : null;
  }
  if (cli === 'codex') {
    const fp = findCodexFile(sessionId);
    return fp ? codexSummary(fp) : null;
  }
  return null;
}

// --- انباشت رویدادها در پیام‌های گروهی دستیار ---
class Flusher {
  constructor() {
    this.messages = [];
    this._buf = [];
    this._bufTimestamp = null;
    this._bufLine = null;
  }
  addEvent(event, timestamp = null, lineNumber = null) {
    if (!this._buf.length) this._bufTimestamp = timestamp;
    this._buf.push(event);
    if (Number.isInteger(lineNumber)) this._bufLine = lineNumber;
  }
  addUser(text, timestamp = null, lineNumber = null) {
    const boundary = Number.isInteger(lineNumber) ? lineNumber - 1 : null;
    this.flush(boundary);
    const message = { role: 'user', text };
    if (timestamp != null) message.timestamp = timestamp;
    this.messages.push(message);
  }
  flush(boundaryLine = null) {
    if (this._buf.length) {
      const message = { role: 'assistant', events: this._buf };
      if (this._bufTimestamp != null) message.timestamp = this._bufTimestamp;
      const forkLine = Number.isInteger(boundaryLine) ? boundaryLine : this._bufLine;
      if (Number.isInteger(forkLine) && forkLine > 0) message._fork_line = forkLine;
      this.messages.push(message);
      this._buf = [];
      this._bufTimestamp = null;
      this._bufLine = null;
    }
  }
}

function claudeTranscript(sessionId) {
  const fp = findClaudeFile(sessionId);
  if (!fp) return [null, null];
  const fl = new Flusher();
  let cwd = null, title = null, lastLine = 0;
  try {
    const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineNumber = i + 1;
      lastLine = lineNumber;
      const obj = loads(lines[i]);
      if (!obj) continue;
      if (obj.cwd && cwd === null) cwd = obj.cwd;
      if (obj.type === 'ai-title' && obj.aiTitle) title = obj.aiTitle;
      const timestamp = obj.timestamp;
      if (obj.type === 'user') {
        claudeUser((obj.message || {}).content, fl, timestamp, lineNumber);
      } else if (obj.type === 'assistant') {
        for (const block of (obj.message || {}).content || []) {
          claudeAssistantBlock(block, fl, timestamp, lineNumber);
        }
      }
    }
  } catch { return [null, null]; }
  fl.flush(lastLine);
  const meta = { cwd: cwd || '', title: (title || firstUserTitle(fl.messages) || 'بدون عنوان').trim().slice(0, 80) };
  return [fl.messages, meta];
}

function claudeUser(content, fl, timestamp, lineNumber) {
  if (typeof content === 'string') {
    if (content.trim()) fl.addUser(content, timestamp, lineNumber);
    return;
  }
  if (Array.isArray(content)) {
    const texts = content.filter((b) => b && typeof b === 'object' && b.type === 'text');
    const results = content.filter((b) => b && typeof b === 'object' && b.type === 'tool_result');
    if (texts.length && !results.length) {
      const joined = texts.map((b) => b.text || '').join('\n');
      if (joined.trim()) fl.addUser(joined, timestamp, lineNumber);
    }
    for (const b of results) {
      fl.addEvent({
        type: 'tool_result',
        text: flattenContent(b.content || ''),
        is_error: Boolean(b.is_error),
      }, timestamp, lineNumber);
    }
  }
}

function claudeAssistantBlock(block, fl, timestamp, lineNumber) {
  if (!block || typeof block !== 'object') return;
  if (block.type === 'text' && String(block.text || '').trim()) {
    fl.addEvent({ type: 'assistant', text: block.text }, timestamp, lineNumber);
  } else if (block.type === 'thinking' && String(block.thinking || '').trim()) {
    fl.addEvent({ type: 'thinking', text: block.thinking }, timestamp, lineNumber);
  } else if (block.type === 'tool_use') {
    fl.addEvent({ type: 'tool_use', name: block.name || '', input: block.input || {} }, timestamp, lineNumber);
  }
}

function codexTranscript(sessionId) {
  const fp = findCodexFile(sessionId);
  if (!fp) return [null, null];

  const messages = [];
  let legacy = new Flusher();
  let modern = new Flusher();
  let legacyTextSeen = false;
  let cwd = null, title = null, lastLine = 0;

  const addCommon = (event, timestamp, lineNumber) => {
    legacy.addEvent(event, timestamp, lineNumber);
    modern.addEvent(event, timestamp, lineNumber);
  };
  const flushTurn = (boundaryLine) => {
    legacy.flush(boundaryLine);
    modern.flush(boundaryLine);
    const selected = legacyTextSeen ? legacy : modern;
    messages.push(...selected.messages);
    legacy = new Flusher();
    modern = new Flusher();
    legacyTextSeen = false;
  };

  try {
    const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineNumber = i + 1;
      lastLine = lineNumber;
      const obj = loads(lines[i]);
      if (!obj) continue;
      const ty = obj.type;
      const pl = obj.payload || {};
      const pt = pl.type;
      const timestamp = obj.timestamp;

      if (ty === 'session_meta') {
        cwd = pl.cwd || cwd;
      } else if (ty === 'event_msg' && pt === 'task_started') {
        flushTurn(lineNumber - 1);
      } else if (ty === 'event_msg' && pt === 'task_complete') {
        flushTurn(lineNumber);
      } else if (ty === 'event_msg' && pt === 'user_message') {
        const text = flattenContent(pl.message ?? pl.text);
        if (text.trim()) {
          legacyTextSeen = true;
          title = title || text;
          legacy.addUser(text, timestamp, lineNumber);
        }
      } else if (ty === 'event_msg' && pt === 'agent_message') {
        const text = flattenContent(pl.message ?? pl.text);
        if (text.trim()) {
          legacyTextSeen = true;
          legacy.addEvent({ type: 'assistant', text }, timestamp, lineNumber);
        }
      } else if (ty === 'response_item' && pt === 'message') {
        const role = pl.role;
        const text = codexMessageText(pl);
        if (role === 'user' && codexVisibleUser(text)) {
          title = title || text;
          modern.addUser(text, timestamp, lineNumber);
        } else if (role === 'assistant' && text.trim()) {
          modern.addEvent({ type: 'assistant', text }, timestamp, lineNumber);
        }
      } else if (ty === 'response_item' && (pt === 'function_call' || pt === 'custom_tool_call')) {
        addCommon(codexToolUse(pl), timestamp, lineNumber);
      } else if (ty === 'response_item' && (pt === 'function_call_output' || pt === 'custom_tool_call_output')) {
        addCommon({ type: 'tool_result', text: flattenContent(pl.output), is_error: false }, timestamp, lineNumber);
      } else if (ty === 'response_item' && pt === 'reasoning') {
        const text = flattenContent(pl.summary || []);
        if (text.trim()) addCommon({ type: 'thinking', text }, timestamp, lineNumber);
      }
    }
  } catch { return [null, null]; }

  flushTurn(lastLine);
  const meta = {
    cwd: cwd || '',
    title: (title || firstUserTitle(messages) || 'بدون عنوان').trim().slice(0, 80),
  };
  return [messages, meta];
}

function codexToolUse(pl) {
  const name = pl.name || 'tool';
  let args = pl.arguments !== undefined ? pl.arguments : pl.input;
  let parsed = args;
  if (typeof args === 'string') {
    try { parsed = JSON.parse(args); } catch { parsed = { input: args }; }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const cmd = parsed.cmd || parsed.command;
    if (cmd) return { type: 'tool_use', name, input: { command: cmd } };
    return { type: 'tool_use', name, input: parsed };
  }
  return { type: 'tool_use', name, input: { input: args } };
}

function firstUserTitle(messages) {
  for (const m of messages) {
    if (m.role === 'user' && m.text) return m.text;
  }
  return 'بدون عنوان';
}

// ------------------------------------------------------------------ //
//  متادیتای مصرف توکن
// ------------------------------------------------------------------ //
export function usageMeta(cli, sessionId) {
  if (cli === 'codex') return codexUsage(sessionId);
  if (cli === 'claude') return claudeUsage(sessionId);
  return null;
}

function codexUsage(sessionId) {
  const fp = findCodexFile(sessionId);
  if (!fp) return null;
  let info = null;
  try {
    for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
      const obj = loads(line);
      if (obj && obj.type === 'event_msg' && (obj.payload || {}).type === 'token_count') {
        info = obj.payload.info || info;
      }
    }
  } catch { return null; }
  if (!info) return null;
  const last = info.last_token_usage || {};
  const total = info.total_token_usage || {};
  const processed = total.total_tokens || 0;
  const cached = total.cached_input_tokens || 0;
  const lastProcessed = last.total_tokens || 0;
  const lastCached = last.cached_input_tokens || 0;
  return {
    context_tokens: last.input_tokens ?? null,
    context_window: info.model_context_window ?? null,
    processed_tokens: processed,
    cached_tokens: cached,
    fresh_tokens: Math.max(0, processed - cached),
    last_processed_tokens: lastProcessed,
    last_cached_tokens: lastCached,
    last_fresh_tokens: Math.max(0, lastProcessed - lastCached),
  };
}

function claudeUsage(sessionId) {
  const fp = findClaudeFile(sessionId);
  if (!fp) return null;
  let lastU = null;
  let processed = 0, cached = 0, fresh = 0;
  let turnProcessed = 0, turnCached = 0, turnFresh = 0;
  let sawUserTurn = false;
  try {
    for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
      const obj = loads(line);
      if (!obj) continue;
      if (obj.type === 'user') {
        if (userText((obj.message || {}).content)) {
          turnProcessed = turnCached = turnFresh = 0;
          sawUserTurn = true;
        }
      }
      if (obj.type === 'assistant') {
        const u = (obj.message || {}).usage;
        if (!u) continue;
        lastU = u;
        const p = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) +
          (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
        const c = u.cache_read_input_tokens || 0;
        const f = p - c;
        processed += p; cached += c; fresh += f;
        if (sawUserTurn) { turnProcessed += p; turnCached += c; turnFresh += f; }
      }
    }
  } catch { return null; }
  if (!lastU) return null;
  const ctx = (lastU.input_tokens || 0) + (lastU.cache_read_input_tokens || 0) +
    (lastU.cache_creation_input_tokens || 0);
  let window = CLAUDE_CONTEXT_WINDOW;
  if (ctx > window) window = 1000000;
  return {
    context_tokens: ctx,
    context_window: window,
    processed_tokens: processed,
    cached_tokens: cached,
    fresh_tokens: fresh,
    last_processed_tokens: turnProcessed,
    last_cached_tokens: turnCached,
    last_fresh_tokens: turnFresh,
  };
}

// ------------------------------------------------------------------ //
//  حذف / فورک سشن
// ------------------------------------------------------------------ //
export function deleteSession(cli, sessionId) {
  const fp = cli === 'claude' ? findClaudeFile(sessionId) :
    cli === 'codex' ? findCodexFile(sessionId) : null;
  if (!fp) return false;
  try { fs.unlinkSync(fp); return true; } catch { return false; }
}

export function forkSession(cli, sessionId, cutoffLine = null) {
  if (!sessionId || !['claude', 'codex'].includes(cli)) return null;
  if (cutoffLine !== null && (!Number.isInteger(cutoffLine) || cutoffLine < 1)) return null;
  const source = cli === 'claude' ? findClaudeFile(sessionId) : findCodexFile(sessionId);
  if (!source) return null;

  const newId = randomUUID();
  let destination;
  if (cli === 'claude') {
    destination = path.join(path.dirname(source), `${newId}.jsonl`);
  } else {
    const now = new Date();
    const fmt = (n) => String(n).padStart(2, '0');
    const folder = path.join(
      CODEX_SESSIONS, String(now.getUTCFullYear()), fmt(now.getUTCMonth() + 1), fmt(now.getUTCDate()),
    );
    const ts = `${now.getUTCFullYear()}-${fmt(now.getUTCMonth() + 1)}-${fmt(now.getUTCDate())}` +
      `T-${fmt(now.getUTCHours())}-${fmt(now.getUTCMinutes())}-${fmt(now.getUTCSeconds())}`;
    destination = path.join(folder, `rollout-${ts}-${newId}.jsonl`);
  }

  const temporary = `${destination}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // کپی در سطح بایت تا ترنسکریپت‌های بزرگ بدون تغییر فرمت JSON کپی شوند
    const oldBuf = Buffer.from(sessionId, 'utf8');
    const newBuf = Buffer.from(newId, 'utf8');
    const content = fs.readFileSync(source);
    const lines = splitBufferLines(content);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (cutoffLine !== null && i + 1 > cutoffLine) break;
      out.push(replaceBuffer(lines[i], oldBuf, newBuf));
    }
    fs.writeFileSync(temporary, Buffer.concat(out));
    fs.renameSync(temporary, destination);
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* بی‌اهمیت */ }
    return null;
  }
  return { session_id: newId, path: destination };
}

function splitBufferLines(buf) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) { parts.push(buf.slice(start, i + 1)); start = i + 1; }
  }
  if (start < buf.length) parts.push(buf.slice(start));
  return parts;
}

function replaceBuffer(buf, oldBuf, newBuf) {
  const idx = buf.indexOf(oldBuf);
  return idx === -1 ? buf : Buffer.concat([buf.slice(0, idx), newBuf, buf.slice(idx + oldBuf.length)]);
}

export function forkPoint(cli, sessionId, messageIndex) {
  if (!Number.isInteger(messageIndex) || messageIndex < 0) return null;
  const [messages] = readTranscript(cli, sessionId);
  if (!messages || messageIndex >= messages.length) return null;
  const message = messages[messageIndex];
  const cutoffLine = message._fork_line;
  if (message.role !== 'assistant' || !Number.isInteger(cutoffLine)) return null;
  const replyNumber = messages.slice(0, messageIndex + 1).filter((m) => m.role === 'assistant').length;
  return { cutoff_line: cutoffLine, reply_number: replyNumber };
}
