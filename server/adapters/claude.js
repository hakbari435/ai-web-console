// آداپتور Claude Code — هر نوبت یک پروسه:
//   claude --print --output-format stream-json --verbose
//          --permission-mode <mode> [--model M] [--resume SID] "<prompt>"
import { CLAUDE_CMD, CLAUDE_MODEL, CLAUDE_PERMISSION_MODE, CLAUDE_SKIP_PERMISSIONS,
         CLAUDE_EXTRA_ARGS, claudeEnv, splitArgs } from '../config.js';
import { Process, ev, flattenContent } from './base.js';

export class ClaudeAdapter {
  get id() { return 'claude'; }

  async *runTurn(text, { sessionId = null, cwd = null, model = null } = {}, onProc) {
    const argv = [CLAUDE_CMD, '--print', '--output-format', 'stream-json', '--verbose'];
    // رابط headless نمی‌تواند پرامپت دسترسی را جواب بدهد (روی ماشین خود کاربر اجرا می‌شود)
    if (CLAUDE_SKIP_PERMISSIONS) argv.push('--dangerously-skip-permissions');
    else argv.push('--permission-mode', CLAUDE_PERMISSION_MODE);
    const chosenModel = model || CLAUDE_MODEL;
    if (chosenModel) argv.push('--model', chosenModel);
    if (sessionId) argv.push('--resume', sessionId);
    if (CLAUDE_EXTRA_ARGS) argv.push(...splitArgs(CLAUDE_EXTRA_ARGS));
    argv.push(text);

    const proc = Process.start(argv, { env: claudeEnv(), cwd });
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
        yield* mapObject(obj);
      }
    } finally {
      await proc.close();
    }

    if (proc.returncode !== 0 && proc.returncode !== null) {
      const detail = proc.stderrText.trim();
      yield ev('error', { text: `claude exited with code ${proc.returncode}\n${detail}` });
    }
  }
}

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
