// تست دکمه توقف: نوبت شروع می‌شود، وسط کار stop می‌فرستیم، پایان باید بیاید
import WebSocket from 'ws';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const API = 'http://127.0.0.1:3000';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwc-stop-'));

const post = async (url, body) => (await fetch(API + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();

const conv = await post('/api/conversations', { title: 'تست توقف', cli: 'claude', cwd: dir });
console.log('گفتگو:', conv.id);

const ws = new WebSocket('ws://127.0.0.1:3000/ws');
const timeout = setTimeout(() => { console.error('⏰ تایم‌اوت — توقف کار نکرد ❌'); process.exit(1); }, 60000);
let sawBusyTrue = false;
let stopped = false;

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'open', cid: conv.id }));
  ws.send(JSON.stringify({
    type: 'message', cid: conv.id,
    text: 'یک برنامه پایتون بنویس که اعداد اول تا یک میلیون را چاپ کند و خروجی کاملش را نشان بده.',
  }));
});
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.cid !== conv.id) return;
  if (msg.type === 'status') {
    console.log('status busy =', msg.busy);
    if (msg.busy) {
      sawBusyTrue = true;
      // وسط اجرا توقف بفرست
      setTimeout(() => {
        console.log('⏹ ارسال توقف...');
        ws.send(JSON.stringify({ type: 'stop', cid: conv.id }));
      }, 500);
    }
  }
  if (msg.type === 'error') console.log('error:', String(msg.text).slice(0, 60));
  if (msg.type === 'done') {
    stopped = true;
    console.log('\n--- نتیجه ---');
    console.log('busy=true دیده شد؟', sawBusyTrue);
    console.log('نوبت بعد از توقف به پایان رسید؟', stopped, '✅');
    clearTimeout(timeout);
    process.exit(0);
  }
});
