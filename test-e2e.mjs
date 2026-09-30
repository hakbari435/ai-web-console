// تست انتها-به-انتهای پروتکل جدید: ساخت گفتگو ← ارسال پیام ← بررسی رویدادها ← بازخوانی تاریخچه
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = 'http://127.0.0.1:3000';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwc2-'));
console.log('پوشه تست:', dir);

const post = async (url, body) => {
  const res = await fetch(API + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
};
const get = async (url) => (await fetch(API + url)).json();

// ۱) ساخت گفتگو
const conv = await post('/api/conversations', { title: 'تست', cli: 'claude', cwd: dir });
console.log('✅ گفتگو ساخته شد:', conv.id);

// ۲) اتصال WS، اشتراک و ارسال پیام
const ws = new WebSocket('ws://127.0.0.1:3000/ws');
const events = [];
let conv2 = null;
const timeout = setTimeout(() => { console.error('⏰ تایم‌اوت'); process.exit(1); }, 180000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'open', cid: conv.id }));
  ws.send(JSON.stringify({
    type: 'message', cid: conv.id,
    text: 'یک فایل به نام hi.txt بساز با محتووی «سلام hello». بعد فقط بنویس: انجام شد',
  }));
});
ws.on('message', async (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.cid !== conv.id && msg.type !== 'init-status') return;
  if (msg.type === 'assistant' || msg.type === 'session' || msg.type === 'status' ||
      msg.type === 'usage' || msg.type === 'error') {
    console.log('📥', msg.type, msg.type === 'assistant' ? msg.text.slice(0, 60) : '');
  }
  events.push(msg);
  if (msg.type === 'done') {
    // ۳) بررسی تاریخچه از ترنسکریپت واقعی
    conv2 = await get(`/api/conversations/${conv.id}?limit=0`);
    const file = path.join(dir, 'hi.txt');
    console.log('\n--- نتایج ---');
    console.log('session_id ذخیره شد؟', Boolean(conv2.session_id));
    console.log('پیام کاربر در تاریخچه؟', conv2.messages.some((m) => m.role === 'user' && m.text.includes('hi.txt')));
    console.log('پاسخ دستیار در تاریخچه؟', conv2.messages.some((m) => m.role === 'assistant'));
    console.log('usage؟', Boolean(conv2.usage));
    console.log('فایل ساخته شد؟', fs.existsSync(file) ? `بله — ${JSON.stringify(fs.readFileSync(file, 'utf8'))}` : 'نه ❌');
    // ۴) جستجو
    const search = await get(`/api/search?q=${encodeURIComponent('سلام hello')}&scope=all&limit=10`);
    console.log('جستجو نتیجه داد؟', search.results.length > 0, `(${search.results.length} نتیجه)`);
    clearTimeout(timeout);
    process.exit(0);
  }
});
ws.on('error', (e) => { console.error('WS:', e.message); process.exit(1); });
