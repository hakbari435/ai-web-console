// مدیر نوبت‌های پس‌زمینه + توزیع رویدادها به کلاینت‌های WebSocket.
// نوبت به «گفتگو» گره خورده نه به سوکتِ شروع‌کننده — جابه‌جا شدن آن را قطع نمی‌کند.
import { WORKDIR, CODEX_EXEC_PREFIX_ARGS, isCodexFamily } from './config.js';
import { readTranscript } from './discovery.js';
import * as sessionStore from './sessionStore.js';
import { ClaudeAdapter, iclaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';

export const ADAPTERS = {
  claude: new ClaudeAdapter(),
  iclaude: iclaudeAdapter(),
  codex: new CodexAdapter(),
  icodex: new CodexAdapter({ id: 'icodex', prefixArgs: CODEX_EXEC_PREFIX_ARGS }),
};

export class Manager {
  constructor() {
    this.running = new Set();    // cid های در حال اجرای نوبت
    this.procs = new Map();      // cid -> پروسه‌ی زنده (برای توقف)
    this.queues = new Map();     // cid -> متن‌های در صف
    this.stopping = new Set();   // cid هایی که توقف خواسته‌اند
    this.buffers = new Map();    // cid -> رویدادهای نوبت جاری (برای subscribe وسط کار)
    this.preHistory = new Map(); // cid -> snapshot تاریخچه در شروع نوبت
    this.subs = new Map();       // cid -> Set<ws>
    this.clients = new Set();    // همه‌ی سوکت‌ها
  }

  // ---- چرخه‌ی کلاینت ----
  addClient(ws) {
    this.clients.add(ws);
    ws.on('close', () => this.removeClient(ws));
  }

  removeClient(ws) {
    this.clients.delete(ws);
    for (const set of this.subs.values()) set.delete(ws);
  }

  subscribe(ws, cid) {
    if (!this.subs.has(cid)) this.subs.set(cid, new Set());
    this.subs.get(cid).add(ws);
    for (const evData of this.buffers.get(cid) || []) {
      safeSend(ws, { ...evData, cid });
    }
  }

  unsubscribe(ws, cid) {
    this.subs.get(cid)?.delete(ws);
  }

  // ---- وضعیت ----
  isBusy(cid) {
    return this.running.has(cid);
  }

  busyIds() {
    return [...this.running];
  }

  // ---- نوبت‌ها ----
  startTurn(cid, text) {
    text = String(text || '').trim();
    if (!text) return;
    const conv = sessionStore.get(cid);
    if (!conv || !ADAPTERS[conv.cli]) return;
    if (this.isBusy(cid)) {
      if (!this.queues.has(cid)) this.queues.set(cid, []);
      this.queues.get(cid).push(text);
      this.broadcastQueue(cid);
      return;
    }
    this.run(cid, text, conv).catch(() => { /* خطاها داخل run هندل می‌شوند */ });
  }

  queueRemove(cid, index) {
    const q = this.queues.get(cid);
    if (Array.isArray(index) === false && Number.isInteger(index) && q && index >= 0 && index < q.length) {
      q.splice(index, 1);
      if (!q.length) this.queues.delete(cid);
      this.broadcastQueue(cid);
    }
  }

  queueEdit(cid, index, text) {
    const q = this.queues.get(cid);
    text = String(text || '').trim();
    if (Number.isInteger(index) && q && index >= 0 && index < q.length && text) {
      q[index] = text;
      this.broadcastQueue(cid);
    }
  }

  broadcastQueue(cid) {
    this.toAll({ type: 'queued', cid, items: [...(this.queues.get(cid) || [])] });
  }

  stopTurn(cid) {
    const hadQueue = this.queues.get(cid);
    this.queues.delete(cid);
    if (this.isBusy(cid)) {
      this.stopping.add(cid);
      const proc = this.procs.get(cid);
      if (proc) {
        try { proc.proc.kill(); } catch { /* بی‌اهمیت */ }
      }
    }
    if (hadQueue) this.broadcastQueue(cid);
  }

  async run(cid, text, conv) {
    const adapter = ADAPTERS[conv.cli];
    const turnTimestamp = new Date().toISOString();
    this.buffers.set(cid, []);
    const sid = conv.session_id;
    try {
      const [msgs] = sid ? readTranscript(conv.cli, sid) : [null];
      this.preHistory.set(cid, msgs || []);
    } catch {
      this.preHistory.set(cid, []);
    }

    this.running.add(cid);

    await this.toSubs(cid, { type: 'user', text, timestamp: turnTimestamp });

    if (['گفتگوی جدید', 'گفتگو', null, undefined, ''].includes(conv.title)) {
      const title = text.slice(0, 40);
      sessionStore.update(cid, { title });
      await this.toAll({ type: 'title', cid, title });
    }

    sessionStore.update(cid, { needs_attention: false });
    await this.toAll({ type: 'status', cid, busy: true, needs_attention: false });

    try {
      const cwd = conv.cwd || WORKDIR;
      const runArgs = {
        sessionId: conv.session_id || null,
        cwd,
        model: conv.model || null,
        reasoningEffort: isCodexFamily(conv.cli) ? (conv.reasoning_effort || null) : null,
      };
      for await (const evData of adapter.runTurn(text, runArgs, (p) => this.procs.set(cid, p))) {
        if (evData.type === 'session') {
          sessionStore.update(cid, { session_id: evData.session_id });
          await this.toAll({ type: 'session', cid, session_id: evData.session_id });
          continue;
        }
        await this.toSubs(cid, evData);
      }
    } catch (err) {
      await this.toSubs(cid, { type: 'error', text: `${err.name || 'Error'}: ${err.message}` });
    }

    this.procs.delete(cid);
    this.buffers.delete(cid);
    this.preHistory.delete(cid);
    this.running.delete(cid);
    if (this.stopping.delete(cid)) {
      await this.toSubs(cid, { type: 'error', text: '⏹ متوقف شد.' }, false);
    }
    await this.toSubs(cid, { type: 'done' }, false);
    const needsAttention = !((this.subs.get(cid) || new Set()).size);
    sessionStore.update(cid, { needs_attention: needsAttention });
    await this.toAll({ type: 'status', cid, busy: false, needs_attention: needsAttention });

    // همه‌ی پیام‌های صف با هم به‌عنوان یک پرامپت ترکیبی
    const queue = this.queues.get(cid);
    this.queues.delete(cid);
    if (queue && queue.length) {
      const combined = queue.join('\n\n');
      this.broadcastQueue(cid);
      const conv2 = sessionStore.get(cid);
      if (conv2) {
        this.run(cid, combined, conv2).catch(() => { /* بی‌اهمیت */ });
      }
    }
  }

  // ---- توزیع ----
  async toSubs(cid, evData, buffer = true) {
    if (buffer) {
      if (!this.buffers.has(cid)) this.buffers.set(cid, []);
      this.buffers.get(cid).push(evData);
    }
    const payload = { ...evData, cid };
    for (const ws of [...(this.subs.get(cid) || [])]) {
      safeSend(ws, payload);
    }
  }

  async toAll(payload) {
    for (const ws of [...this.clients]) safeSend(ws, payload);
  }

  markRead(cid) {
    const conv = sessionStore.get(cid);
    if (!conv) return null;
    if (conv.needs_attention) {
      return sessionStore.update(cid, { needs_attention: false });
    }
    return conv;
  }
}

function safeSend(ws, payload) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  } catch { /* بی‌اهمیت */ }
}
