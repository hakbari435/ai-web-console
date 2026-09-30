// ذخیره‌سازی JSON اتمیک برای متادیتای محلی (sessions/overrides/models)
import fs from 'node:fs';
import path from 'node:path';

export function readJson(file, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) === Array.isArray(fallback) ? data : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
