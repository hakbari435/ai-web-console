// آداپتور Claude Code — هر نوبت یک پروسه:
//   claude --print --output-format stream-json --verbose
//          --permission-mode <mode> [--model M] [--resume SID] "<prompt>"
//   iclaude: iclaude run <همان آرگومان‌ها>
import { CLAUDE_CMD, CLAUDE_MODEL, CLAUDE_PERMISSION_MODE, CLAUDE_SKIP_PERMISSIONS,
         CLAUDE_EXTRA_ARGS, ICLAUDE_CMD, claudeEnv, iclaudeEnv, splitArgs } from '../config.js';
import os from 'node:os';
import path from 'node:path';
import { Process, ev, flattenContent } from './base.js';

const NON_INTERACTIVE_HINT =
  'سرویس iclaude اجرای غیرتعاملی (--print) را نمی‌پذیرد؛ این سشن را در ترمینال با iclaude run ادامه دهید.';

export class ClaudeAdapter {
  constructor({ id = 'claude', command = [CLAUDE_CMD], env = claudeEnv, extraArgs = () => [],
                errorHint = null } = {}) {
    this._id = id;
    this.command = command;
    this.env = env;
    this.extraArgs = extraArgs;
    this.errorHint = errorHint;
  }

  get id() { return this._id; }

  async *runTurn(text, { sessionId = null, cwd = null, model = null } = {}, onProc) {
    const argv = [...this.command, '--print', '--output-format', 'stream-json', '--verbose'];
    // رابط headless نمی‌تواند پرامپت دسترسی را جواب بدهد (روی ماشین خود کاربر اجرا می‌شود)
    if (CLAUDE_SKIP_PERMISSIONS) argv.push('--dangerously-skip-permissions');
    else argv.push('--permission-mode', CLAUDE_PERMISSION_MODE);
    const chosenModel = model || CLAUDE_MODEL;
    if (chosenModel) argv.push('--model', chosenModel);
    if (sessionId) argv.push('--resume', sessionId);
    if (CLAUDE_EXTRA_ARGS) argv.push(...splitArgs(CLAUDE_EXTRA_ARGS));
    argv.push(...this.extraArgs(cwd));
    argv.push(text);

    const proc = Process.start(argv, { env: this.env(), cwd });
    if (onProc) onProc(proc);
    let lastSid = null;
    try {
      for await (const line of proc.lines()) {
        const s = line.trim();
        if (!s) continue;
        let obj;
        try { obj = JSON.parse(s); } catch { continue; }
        const sid = obj.session_id;
        if (sid && sid !== lastSid) {
          lastSid = sid;
          yield ev('session', { session_id: sid });
        }
        for (const e of mapObject(obj)) {
          const hint = e.type === 'error' && this.errorHint && this.errorHint(e.text);
          yield hint ? { ...e, text: `${e.text}\n${hint}` } : e;
        }
      }
    } finally {
      await proc.close();
    }

    if (proc.returncode !== 0 && proc.returncode !== null) {
      const detail = proc.stderrText.trim();
      yield ev('error', { text: `${this._id} exited with code ${proc.returncode}\n${detail}` });
    }
  }
}

// وقتی cwd خود پوشه‌ی خانه است، Claude Code فایل ~/.claude/settings.json را «تنظیمات پروژه» هم
// حساب می‌کند؛ توکن Open Source داخل آن اعتبارنامه‌ی iclaude را کنار می‌زند. پس آن لایه حذف می‌شود.
function isHomeDir(cwd) {
  if (!cwd) return false;
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(cwd) === norm(os.homedir());
}

export const iclaudeAdapter = () => new ClaudeAdapter({
  id: 'iclaude',
  command: [ICLAUDE_CMD, 'run'],
  env: iclaudeEnv,
  extraArgs: (cwd) => (isHomeDir(cwd) ? ['--setting-sources', 'user,local'] : []),
  errorHint: (text) => (/Non-interactive use/i.test(text || '') ? NON_INTERACTIVE_HINT : null),
});

function* mapObject(obj) {
  const kind = obj.type;

  if (kind === 'assistant') {
    for (const block of (obj.message || {}).content || []) {
      if (block.type === 'text') {
        if (String(block.text || '').trim()) yield ev('assistant', { text: block.text });
      } else if (block.type === 'thinking') {
        if (String(block.thinking || '').trim()) yield ev('thinking', { text: block.thinking });
      } else if (block.type === 'tool_use') {
        yield ev('tool_use', { name: block.name || '', input: block.input || {} });
      }
    }
  } else if (kind === 'user') {
    const content = (obj.message || {}).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && block.type === 'tool_result') {
          yield ev('tool_result', {
            text: flattenContent(block.content ?? ''),
            is_error: Boolean(block.is_error),
          });
        }
      }
    }
  } else if (kind === 'result') {
    const usage = obj.usage || {};
    yield ev('usage', {
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      cost_usd: obj.total_cost_usd ?? null,
    });
    if (obj.is_error || !['success', null, undefined].includes(obj.subtype)) {
      const msg = obj.result || obj.subtype || 'unknown error';
      yield ev('error', { text: String(msg) });
    }
  }
}
