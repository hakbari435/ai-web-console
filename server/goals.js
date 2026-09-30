// خواندن هدف‌های Codex از ~/.codex/goals_1.sqlite (فقط خواندنی — دیتابیس ملک Codex است)
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const GOALS_DB = path.join(os.homedir(), '.codex', 'goals_1.sqlite');

// node:sqlite از Node 22.5 به بعد داخلی است
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch { /* نسخه‌ی قدیمی — هدف‌ها غیرفعال می‌شوند */ }

function connect() {
  const uri = `file:${GOALS_DB.replace(/\\/g, '/')}?mode=ro`;
  return new DatabaseSync(uri, { readOnly: true });
}

export function allGoals() {
  if (!DatabaseSync || !fs.existsSync(GOALS_DB)) return {};
  try {
    const con = connect();
    const rows = con.prepare(
      'select thread_id, objective, status, tokens_used, updated_at_ms from thread_goals',
    ).all();
    con.close();
    const out = {};
    const seen = {};
    for (const row of rows) {
      const updated = row.updated_at_ms || 0;
      if (!(row.thread_id in out) || updated > (seen[row.thread_id] || 0)) {
        seen[row.thread_id] = updated;
        out[row.thread_id] = {
          objective: row.objective, status: row.status, tokens_used: row.tokens_used,
        };
      }
    }
    return out;
  } catch { return {}; }
}

export function getGoal(sessionId) {
  if (!DatabaseSync || !fs.existsSync(GOALS_DB) || !sessionId) return null;
  try {
    const con = connect();
    const row = con.prepare(
      'select objective, status, tokens_used from thread_goals where thread_id = ? ' +
      'order by updated_at_ms desc limit 1',
    ).get(sessionId);
    con.close();
    if (!row) return null;
    return { objective: row.objective, status: row.status, tokens_used: row.tokens_used };
  } catch { return null; }
}
