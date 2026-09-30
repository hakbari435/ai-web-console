// زیرساخت مشترک آداپتورها: اجرای پروسه + استریم خطوط stdout + جمع‌آوری stderr
import { spawn } from 'node:child_process';

// اشکال رویدادهای نرمال‌شده (مطابق نسخه‌ی مرجع):
//   {type:"session", session_id}  — شناسه برای resume (داخلی)
//   {type:"assistant", text}      — مارک‌داون
//   {type:"thinking", text}
//   {type:"tool_use", name, input}
//   {type:"tool_result", text, is_error}
//   {type:"usage", input_tokens, output_tokens, cost_usd}
//   {type:"error", text}
export class Process {
  constructor(proc) {
    this.proc = proc;
    this._stderr = '';
  }

  static start(argv, { env = process.env, cwd = null, stdinText = null } = {}) {
    const proc = spawn(argv[0], argv.slice(1), {
      env,
      cwd: cwd || undefined,
      stdio: [stdinText !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const self = new Process(proc);
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c) => { self._stderr += c; });
    if (stdinText !== null) {
      proc.stdin.on('error', () => { /* بی‌اهمیت */ });
      proc.stdin.write(stdinText, 'utf8');
      proc.stdin.end();
    }
    return self;
  }

  // async generator از خطوط stdout (تا پایان جریان)
  lines() {
    return lineIterator(this.proc.stdout);
  }

  get returncode() {
    return this.proc.exitCode;
  }

  get stderrText() {
    return this._stderr;
  }

  close() {
    return new Promise((resolve) => {
      const p = this.proc;
      if (p.exitCode === null && p.signalCode === null) {
        try { p.kill(); } catch { /* بی‌اهمیت */ }
      }
      p.once('exit', () => resolve());
      setTimeout(() => resolve(), 1000).unref();
    });
  }
}

async function* lineIterator(stream) {
  stream.setEncoding('utf8');
  let buf = '';
  let ended = false;
  let error = null;
  const waiters = [];
  const wake = () => { while (waiters.length) waiters.shift()(); };

  stream.on('data', (chunk) => { buf += chunk; wake(); });
  stream.on('end', () => { ended = true; wake(); });
  stream.on('error', (e) => { error = e; ended = true; wake(); });

  while (true) {
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      yield line;
    }
    if (ended) {
      if (error) throw error;
      if (buf) yield buf;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
  }
}

export function ev(type, kw = {}) {
  return { type, ...kw };
}

export { flattenContent } from '../discovery.js';
