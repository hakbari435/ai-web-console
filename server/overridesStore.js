// نام‌های نمایشی سفارشی سشن‌ها — لایه‌ی روبه‌روی ترنسکریپت‌ها، بدون تغییر آن‌ها
import path from 'node:path';
import { BASE_DIR } from './config.js';
import { readJson, writeJson } from './stores.js';

const FILE = path.join(BASE_DIR, '.ai-web-console', 'overrides.json');
const key = (cli, sessionId) => `${cli}:${sessionId}`;

export function allNames() {
  return readJson(FILE, {});
}

export function getName(cli, sessionId) {
  return allNames()[key(cli, sessionId)] || null;
}

export function setName(cli, sessionId, name) {
  const data = allNames();
  const k = key(cli, sessionId);
  if (name && name.trim()) data[k] = name.trim();
  else delete data[k];
  writeJson(FILE, data);
}

export function removeName(cli, sessionId) {
  const data = allNames();
  if (key(cli, sessionId) in data) {
    delete data[key(cli, sessionId)];
    writeJson(FILE, data);
  }
}
