// جستجوی متنی مستقیم روی ترنسکریپت‌های محلی Claude و Codex (بدون ایندکس)
import path from 'node:path';
import { listSessions, readTranscript } from './discovery.js';

const ARABIC_VARIANTS = {
  'ي': 'ی', 'ى': 'ی', 'ك': 'ک', 'ة': 'ه', 'ۀ': 'ه', 'ؤ': 'و', 'إ': 'ا', 'أ': 'ا',
};

export function normalizeText(value) {
  let text = String(value || '').normalize('NFKC');
  for (const [from, to] of Object.entries(ARABIC_VARIANTS)) {
    text = text.split(from).join(to);
  }
  text = text.split('‌').join(' ');
  // حذف کاراکترهای ترکیبی (اعراب عربی)
  text = text.replace(/[̀-ͯ]/g, '');
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function pathKey(value) {
  return path.normalize(String(value || '')).toLowerCase()
    .replace(/\\/g, '/').replace(/\/+$/, '');
}

function messageText(message) {
  if (message.role === 'user') return String(message.text || '');
  if (message.role === 'assistant') {
    return (message.events || [])
      .filter((e) => e.type === 'assistant' && e.text)
      .map((e) => String(e.text))
      .join('\n');
  }
  return '';
}

function snippet(text, normalizedQuery, radius = 150) {
  const normalized = normalizeText(text);
  let matchAt = normalized.indexOf(normalizedQuery);
  if (matchAt < 0) matchAt = 0;
  if (normalized) {
    matchAt = Math.round(matchAt * text.length / normalized.length);
  }
  const start = Math.max(0, matchAt - radius);
  const end = Math.min(text.length, matchAt + normalizedQuery.length + radius);
  let out = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) out = '…' + out;
  if (end < text.length) out += '…';
  return out;
}

export function searchTranscripts(query, { scope = 'all', project = '', sessionId = '', limit = 100 } = {}) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return { results: [], searched_sessions: 0, matched_sessions: 0, truncated: false };
  }

  let sessions = listSessions('all', 100000);
  if (scope === 'project') {
    const projectKey = pathKey(project);
    sessions = sessions.filter((s) => pathKey(s.cwd) === projectKey);
  } else if (scope === 'session') {
    sessions = sessions.filter((s) => s.session_id === sessionId);
  }

  const results = [];
  let searchedSessions = 0;
  const matchedSessions = new Set();
  let truncated = false;

  outer:
  for (const session of sessions) {
    const [messages] = readTranscript(session.cli, session.session_id);
    if (!messages) continue;
    searchedSessions++;
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const message = messages[messageIndex];
      const text = messageText(message);
      if (!text || !normalizeText(text).includes(normalizedQuery)) continue;
      results.push({
        cli: session.cli,
        session_id: session.session_id,
        title: session.title || '',
        cwd: session.cwd || '',
        role: message.role,
        timestamp: message.timestamp ?? null,
        message_index: messageIndex,
        snippet: snippet(text, normalizedQuery),
      });
      matchedSessions.add(`${session.cli}:${session.session_id}`);
      if (results.length >= limit) { truncated = true; break outer; }
    }
  }

  return {
    results,
    searched_sessions: searchedSessions,
    matched_sessions: matchedSessions.length,
    truncated,
  };
}
