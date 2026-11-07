// لیست مدل‌های قابل‌ویرایش هر CLI — ذخیره در .ai-web-console/models.json
import path from 'node:path';
import { BASE_DIR, CLAUDE_MODELS, CODEX_MODELS } from './config.js';
import { readJson, writeJson } from './stores.js';

const FILE = path.join(BASE_DIR, '.ai-web-console', 'models.json');

const defaults = () => ({
  claude: CLAUDE_MODELS.split(',').map((s) => s.trim()).filter(Boolean),
  iclaude: CLAUDE_MODELS.split(',').map((s) => s.trim()).filter(Boolean),
  codex: CODEX_MODELS.split(',').map((s) => s.trim()).filter(Boolean),
  icodex: CODEX_MODELS.split(',').map((s) => s.trim()).filter(Boolean),
});

export function getAll() {
  const data = defaults();
  const saved = readJson(FILE, {});
  for (const cli of ['claude', 'iclaude', 'codex', 'icodex']) {
    if (Array.isArray(saved[cli])) data[cli] = saved[cli].map(String);
  }
  return data;
}

export function setCli(cli, models) {
  const data = getAll();
  data[cli] = [...new Set(models.map((m) => String(m).trim()).filter(Boolean))];
  writeJson(FILE, data);
  return data;
}
