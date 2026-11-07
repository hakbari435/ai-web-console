// پایش زنده‌ی فایل‌های سشن CLI روی دیسک: وقتی از ترمینال با Claude/Codex چت می‌شود،
// وب‌ویوهایی که همان گفتگو را باز کرده‌اند و سایدبار بلافاصله باخبر می‌شوند.
import fs from 'node:fs';
import { CLAUDE_PROJECTS, CODEX_SESSIONS } from './discovery.js';
import * as sessionStore from './sessionStore.js';

// Claude: <uuid>.jsonl   Codex: rollout-<ts>-<uuid>.jsonl
const SESSION_FILE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const SESSION_DEBOUNCE_MS = 300;
const LIST_DEBOUNCE_MS = 1000;
// هر پوشه بین دو CLI مشترک است (claude/iclaude، codex/icodex)
const FAMILY = { claude: ['claude', 'iclaude'], codex: ['codex', 'icodex'] };

export function watchSessions(manager) {
  const sessionTimers = new Map();
  let listTimer = null;

  const fire = (cli, sessionId) => {
    const conv = FAMILY[cli].map((c) => sessionStore.findBySession(c, sessionId)).find(Boolean);
    // نوبتی که از خود وب اجرا می‌شود جداگانه زنده استریم می‌شود
    if (conv && manager.isBusy(conv.id)) return;
    if (conv) manager.toSubs(conv.id, { type: 'transcript_changed' }, false);
    clearTimeout(listTimer);
    listTimer = setTimeout(() => manager.toAll({ type: 'sessions_changed' }), LIST_DEBOUNCE_MS);
  };

  // فایل سشن هنگام استریم خط‌به‌خط نوشته می‌شود؛ رویدادها debounce می‌شوند
  const onChange = (cli, filename) => {
    const m = filename && String(filename).match(SESSION_FILE);
    if (!m) return;
    const key = `${cli}:${m[1]}`;
    clearTimeout(sessionTimers.get(key));
    sessionTimers.set(key, setTimeout(() => {
      sessionTimers.delete(key);
      fire(cli, m[1]);
    }, SESSION_DEBOUNCE_MS));
  };

  for (const [cli, dir] of [['claude', CLAUDE_PROJECTS], ['codex', CODEX_SESSIONS]]) {
    try {
      const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => onChange(cli, filename));
      watcher.on('error', () => { /* پوشه حذف شد — پایش این CLI متوقف می‌شود */ });
    } catch { /* پوشه وجود ندارد یا recursive پشتیبانی نمی‌شود */ }
  }
}
