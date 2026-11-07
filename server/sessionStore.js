// مخزن سبک‌وزن گفتگوها — مطابق نسخه‌ی مرجع: پیام‌ها ذخیره نمی‌شوند؛
// فایل سشن خود CLI منبع حقیقت است و هر بار تازه از دیسک خوانده می‌شود.
// همه‌ی عملیات‌ها synchronous اند (Node تک‌نخ است) و نوشتن اتمیک انجام می‌شود.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BASE_DIR } from './config.js';
import { readJson, writeJson } from './stores.js';

const FILE = path.join(BASE_DIR, '.ai-web-console', 'sessions.json');

function load() {
  const data = readJson(FILE, { conversations: [] });
  for (const conv of data.conversations) {
    delete conv.messages;
    if (!('needs_attention' in conv)) conv.needs_attention = false;
  }
  return data;
}

export function listConversations() {
  return load().conversations;
}

export function create({ cli, title = null, cwd = null, sessionId = null, imported = false,
                         model = null, reasoningEffort = null }) {
  const data = load();
  const conv = {
    id: randomUUID().slice(0, 12),
    cli,
    title: title || 'گفتگوی جدید',
    cwd,
    model,
    reasoning_effort: reasoningEffort,
    session_id: sessionId,
    imported,
    needs_attention: false,
    created: Date.now() / 1000,
    updated: Date.now() / 1000,
  };
  data.conversations.unshift(conv);
  writeJson(FILE, data);
  return conv;
}

export function findBySession(cli, sessionId) {
  if (!sessionId) return null;
  return load().conversations.find((c) => c.cli === cli && c.session_id === sessionId) || null;
}

export function get(id) {
  return load().conversations.find((c) => c.id === id) || null;
}

export function update(id, fields) {
  const data = load();
  const conv = data.conversations.find((c) => c.id === id);
  if (!conv) return null;
  Object.assign(conv, fields);
  conv.updated = Date.now() / 1000;
  writeJson(FILE, data);
  return conv;
}

export function remove(id) {
  const data = load();
  data.conversations = data.conversations.filter((c) => c.id !== id);
  writeJson(FILE, data);
}

export function removeByCwd(cwd) {
  if (!cwd) return;
  const data = load();
  const kept = data.conversations.filter((c) => c.cwd !== cwd);
  if (kept.length !== data.conversations.length) {
    data.conversations = kept;
    writeJson(FILE, data);
  }
}

export function deleteBySession(cli, sessionId) {
  if (!sessionId) return;
  const data = load();
  const kept = data.conversations.filter(
    (c) => !(c.cli === cli && c.session_id === sessionId),
  );
  if (kept.length !== data.conversations.length) {
    data.conversations = kept;
    writeJson(FILE, data);
  }
}
