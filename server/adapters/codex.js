// آداپتور Codex CLI — هر نوبت یک پروسه:
//   codex exec [resume SID] --json --skip-git-repo-check --sandbox <mode> [-C cwd] -o <file> -
//   icodex: همان، با پیشوند لانچر سفارشی (codexx = codex -c model_provider=proxy --search)
// پرامپت از stdin نوشته می‌شود تا escape شلی لازم نباشد.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODEX_BYPASS, CODEX_SANDBOX, CODEX_EXTRA_ARGS, codexEnv, codexCommand, splitArgs } from '../config.js';
import { Process, ev, flattenContent } from './base.js';

const SESSION_KEYS = ['thread_id', 'session_id', 'conversation_id', 'rollout_id', 'id'];
const ASSISTANT_ITEMS = ['assistant_message', 'agent_message', 'message', 'output_text'];
const SHELL_ITEMS = ['command_execution', 'local_shell_call', 'exec_command', 'shell_call'];

export class CodexAdapter {
  constructor({ id = 'codex', prefixArgs = '' } = {}) {
    this._id = id;
    this.prefixArgs = prefixArgs;
  }

  get id() { return this._id; }

  async *runTurn(text, { sessionId = null, cwd = null, model = null,
                         reasoningEffort = null } = {}, onProc) {
    const lastMsgFile = path.join(os.tmpdir(), `codex-last-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

    // فلگ‌های exec باید قبل از زیرفرمان resume بیایند
    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (CODEX_BYPASS) args.push('--dangerously-bypass-approvals-and-sandbox');
    else if (CODEX_SANDBOX) args.push('--sandbox', CODEX_SANDBOX);
    if (cwd) args.push('-C', cwd);
    if (model) args.push('-m', model);
    args.push('-o', lastMsgFile);
    if (CODEX_EXTRA_ARGS) args.push(...splitArgs(CODEX_EXTRA_ARGS));
    if (reasoningEffort) args.push('-c', `model_reasoning_effort=${reasoningEffort}`);

    let emittedAssistant = false;
    let subcommand = sessionId ? 'resume' : null;
    let sid = sessionId;
    let proc = null;

    try {
      while (true) {
        const attemptArgs = [...args];
        if (sid) attemptArgs.push(subcommand, sid, '-');
        else attemptArgs.push('-');

        const argv = codexCommand(attemptArgs, this.prefixArgs);
        proc = Process.start(argv, { env: codexEnv(), cwd, stdinText: text });
        if (onProc) onProc(proc);
        let lastSid = null;
        try {
          for await (const line of proc.lines()) {
            const s = line.trim();
            if (!s) continue;
            let obj;
            try { obj = JSON.parse(s); } catch { continue; }

            const sessionEv = sessionIdOf(obj);
            if (sessionEv && sessionEv !== lastSid) {
              lastSid = sessionEv;
              yield ev('session', { session_id: sessionEv });
            }

            for (const event of mapObject(obj)) {
              if (event.type === 'assistant') emittedAssistant = true;
              yield event;
            }
          }
        } finally {
          await proc.close();
        }

        // سشن ممکن است در سوییت دیگری فعال باشد → با fork ادامه بده
        if (
          subcommand === 'resume' && !emittedAssistant &&
          proc.returncode !== 0 && proc.returncode !== null &&
          isActiveWriterConflict(proc.stderrText)
        ) {
          subcommand = 'fork';
          try { fs.writeFileSync(lastMsgFile, ''); } catch { /* بی‌اهمیت */ }
          continue;
        }
        break;
      }

      // تور ایمنی: اگر متنی استریم نشد، پیام نهایی از فایل -o خوانده می‌شود
      if (!emittedAssistant) {
        try {
          const final = fs.readFileSync(lastMsgFile, 'utf8').trim();
          if (final) yield ev('assistant', { text: final });
        } catch { /* بی‌اهمیت */ }
      }

      if (proc && proc.returncode !== 0 && proc.returncode !== null) {
        const detail = cleanStderr(proc.stderrText);
        const suffix = detail ? `\n${detail}` : '';
        yield ev('error', { text: `${this._id} exited with code ${proc.returncode}${suffix}` });
      }
    } finally {
      try { fs.unlinkSync(lastMsgFile); } catch { /* بی‌اهمیت */ }
    }
  }
}

function isActiveWriterConflict(stderr) {
  const v = String(stderr).toLowerCase();
  return v.includes('already has an active writer') || v.includes('thread-store conflict');
}

function cleanStderr(stderr) {
  const ignored = ['codex_login::auth::manager: failed to refresh token'];
  const lines = String(stderr).split(/\r?\n/).filter((line) => {
    const low = line.toLowerCase();
    return line.trim() && !ignored.some((m) => low.includes(m));
  });
  return lines.join('\n').trim();
}

function sessionIdOf(obj) {
  const kind = obj.type || '';
  if (['thread.started', 'session.created', 'session_configured', 'session.started'].includes(kind)) {
    for (const key of SESSION_KEYS) {
      if (obj[key]) return obj[key];
    }
  }
  const nested = obj.session || obj.thread || {};
  if (nested && typeof nested === 'object') {
    for (const key of SESSION_KEYS) {
      if (nested[key]) return nested[key];
    }
  }
  return null;
}

function* mapObject(obj) {
  const kind = obj.type || '';
  const item = obj.item && typeof obj.item === 'object' ? obj.item : {};
  const itype = item.type || item.item_type || '';

  if (ASSISTANT_ITEMS.includes(itype) || ['assistant_message', 'message'].includes(kind)) {
    const txt = flattenContent(item.text ?? item.content ?? obj.text);
    if (String(txt).trim()) yield ev('assistant', { text: txt });
  } else if (itype === 'reasoning' || kind === 'reasoning') {
    const txt = flattenContent(item.text ?? obj.text);
    if (String(txt).trim()) yield ev('thinking', { text: txt });
  } else if (SHELL_ITEMS.includes(itype)) {
    let command = item.command ?? item.cmd ?? '';
    if (Array.isArray(command)) command = command.join(' ');
    yield ev('tool_use', { name: 'shell', input: { command } });
    const output = item.aggregated_output ?? item.output ?? '';
    if (output) {
      yield ev('tool_result', {
        text: flattenContent(output),
        is_error: ![0, null, undefined].includes(item.exit_code),
      });
    }
  }

  if (['turn.completed', 'turn.complete'].includes(kind)) {
    const usage = obj.usage || {};
    yield ev('usage', {
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      cost_usd: null,
    });
  } else if (kind === 'error') {
    yield ev('error', { text: flattenContent(obj.message ?? obj.error ?? JSON.stringify(obj)) });
  }
}
