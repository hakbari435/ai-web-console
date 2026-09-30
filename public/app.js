"use strict";

/* ------------------------------------------------------------------ *
 *  Minimal, dependency-free Markdown -> HTML (tables + RTL friendly).
 * ------------------------------------------------------------------ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
function inlineMd(s) {
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, (m, c) => `<code class="inl">${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // No __x__ bold: it eats Python dunders like __init__ / __main__.
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}
// Persian-primary base direction: ANY Persian/Arabic letter -> RTL.
// Only prose with zero RTL letters is LTR. Counting letters is wrong here:
// code identifiers (product_id, BaseWorker, ...) inflate the Latin count and
// wrongly flip a Persian sentence to LTR, scrambling it.
function dirOf(s) {
  return /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(String(s)) ? "rtl" : "ltr";
}
function renderTable(header, rows) {
  let h = '<div class="tbl-wrap"><table><thead><tr>';
  h += header.map((c) => `<th dir="${dirOf(c)}">${inlineMd(c)}</th>`).join("");
  h += "</tr></thead><tbody>";
  h += rows.map((r) => "<tr>" + r.map((c) => `<td dir="${dirOf(c)}">${inlineMd(c)}</td>`).join("") + "</tr>").join("");
  h += "</tbody></table></div>";
  return h;
}
function mdToHtml(src) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  let out = "";
  let i = 0;
  const blockStart = /^(```|#{1,6}\s|\s*>\s|\s*([-*+]|[0-9۰-۹٠-٩]+\.)\s|\s*\|.*\|\s*$)/;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      i++;
      const code = [];
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      out += `<pre class="code"><code>${escapeHtml(code.join("\n"))}</code></pre>`;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length &&
        /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") { rows.push(splitRow(lines[i])); i++; }
      out += renderTable(header, rows);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      const lvl = line.match(/^#+/)[0].length;
      const raw = line.replace(/^#+\s/, "");
      out += `<h${lvl} dir="${dirOf(raw)}">${inlineMd(raw)}</h${lvl}>`;
      i++; continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      out += `<blockquote dir="${dirOf(q.join(" "))}">${mdToHtml(q.join("\n"))}</blockquote>`;
      continue;
    }
    const listMatch = line.match(/^\s*([-*+]|([0-9۰-۹٠-٩]+)\.)\s+(.+)$/);
    if (listMatch) {
      const ordered = Boolean(listMatch[2]);
      const marker = ordered
        ? /^\s*[0-9۰-۹٠-٩]+\.\s+(.+)$/
        : /^\s*[-*+]\s+(.+)$/;
      const items = [];
      const start = ordered ? Number(listMatch[2].replace(/[۰-۹٠-٩]/g, (d) =>
        "۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩".indexOf(d) % 10)) : null;

      while (i < lines.length) {
        const itemMatch = lines[i].match(marker);
        if (!itemMatch) break;
        const parts = [itemMatch[1]];
        i++;
        while (i < lines.length && lines[i].trim() && !blockStart.test(lines[i])) {
          parts.push(lines[i].trim());
          i++;
        }
        const raw = parts.join(" ");
        items.push(`<li dir="${dirOf(raw)}">${inlineMd(raw)}</li>`);

        // Markdown commonly separates numbered items with a blank line. Keep
        // them in one <ol>; separate <ol>s would restart every marker at 1.
        let next = i;
        while (next < lines.length && !lines[next].trim()) next++;
        if (next < lines.length && marker.test(lines[next])) i = next;
        else break;
      }

      const tag = ordered ? "ol" : "ul";
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : "";
      out += `<${tag}${startAttr}>${items.join("")}</${tag}>`;
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const para = [line]; i++;
    while (i < lines.length && lines[i].trim() !== "" && !blockStart.test(lines[i])) { para.push(lines[i]); i++; }
    const raw = para.join(" ");
    out += `<p dir="${dirOf(raw)}">${inlineMd(raw)}</p>`;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  State + helpers
 * ------------------------------------------------------------------ */
const state = {
  clis: [], conversations: [], ext: [], models: {}, workdir: "",
  codexCatalog: { source: "fallback", models: [], error: null },
  codexDefaults: new Map(),
  viewCid: null, busy: new Set(), ws: null, assistantBody: null,
  expanded: new Set(), _extInit: false, queue: [], sidebarCollapsed: false,
  searchOpen: false, searchScope: "all", searchRequest: 0,
  collapsedSearchProjects: new Set(), collapsedSearchSessions: new Set(),
};
const BASE_PAGE_TITLE = document.title;
const SESSION_URL_PARAM = "session";
const MESSAGE_URL_PARAM = "message";

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const res = await fetch(url, opt);
  return res.json();
}
const messagesEl = () => $("#messages");
function scrollDown() { const m = messagesEl(); m.scrollTop = m.scrollHeight; }
function cliLabel(id) { const c = state.clis.find((x) => x.id === id); return c ? c.label : id; }
function trimmedPath(p) { return String(p || "").replace(/[\\/]+$/, ""); }
function baseName(p) {
  const path = trimmedPath(p);
  if (!path) return "";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}
function parentPath(p) {
  const path = trimmedPath(p);
  const splitAt = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return splitAt > 0 ? path.slice(0, splitAt) : "";
}
function setPageTitle(title) {
  const clean = String(title || "").replace(/\s+/g, " ").trim();
  document.title = clean ? `${clean} · ${BASE_PAGE_TITLE}` : BASE_PAGE_TITLE;
}
function setConversationHeading(title, cwd = "") {
  const titleEl = $("#conv-title");
  const projectEl = $("#conv-project");
  const cleanTitle = title || "گفتگو";
  titleEl.textContent = cleanTitle;
  titleEl.title = cleanTitle;
  if (projectEl) {
    const projectName = baseName(cwd);
    projectEl.textContent = projectName ? `پروژه: ${projectName}` : "";
    projectEl.title = cwd || "";
    projectEl.hidden = !projectName;
  }
}
function sessionUrlKey(conv) { return conv && (conv.session_id || conv.id); }
function sessionKeyFromUrl() {
  return new URL(window.location.href).searchParams.get(SESSION_URL_PARAM) || "";
}
function messageIndexFromUrl() {
  const raw = new URL(window.location.href).searchParams.get(MESSAGE_URL_PARAM);
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}
function updateSessionUrl(conv, mode = "push", messageIndex = null) {
  if (mode === "none") return;
  const key = sessionUrlKey(conv);
  if (!key) return;
  const url = new URL(window.location.href);
  url.searchParams.set(SESSION_URL_PARAM, key);
  if (Number.isInteger(messageIndex)) url.searchParams.set(MESSAGE_URL_PARAM, String(messageIndex));
  else url.searchParams.delete(MESSAGE_URL_PARAM);
  if (url.toString() === window.location.href) return;
  const method = mode === "replace" ? "replaceState" : "pushState";
  window.history[method]({ session: key }, "", url);
}
function clearSessionUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(SESSION_URL_PARAM) && !url.searchParams.has(MESSAGE_URL_PARAM)) return;
  url.searchParams.delete(SESSION_URL_PARAM);
  url.searchParams.delete(MESSAGE_URL_PARAM);
  window.history.replaceState({}, "", url);
}
function savedSidebarState() {
  try { return window.localStorage.getItem("sidebar-collapsed") === "1"; }
  catch (e) { return false; }
}
function setSidebarCollapsed(collapsed, persist = true) {
  state.sidebarCollapsed = Boolean(collapsed);
  $("#app").classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  const button = $("#sidebar-toggle");
  button.setAttribute("aria-expanded", String(!state.sidebarCollapsed));
  button.title = state.sidebarCollapsed ? "باز کردن منوی پروژه‌ها" : "بستن منوی پروژه‌ها";
  if (persist) {
    try { window.localStorage.setItem("sidebar-collapsed", state.sidebarCollapsed ? "1" : "0"); }
    catch (e) { /* Browser storage may be disabled. */ }
  }
}
function timeStr(mtime) {
  try { return new Date(mtime * 1000).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" }); }
  catch (e) { return ""; }
}
function timestampDate(timestamp) {
  if (timestamp === undefined || timestamp === null || timestamp === "") return null;
  let value = timestamp;
  if (typeof value === "number" && Math.abs(value) < 1e12) value *= 1000;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function localDayKey(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function messageTimeText(date) {
  return date.toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" });
}
function messageDayText(date) {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const key = localDayKey(date);
  if (key === localDayKey(today)) return "\u0627\u0645\u0631\u0648\u0632";
  if (key === localDayKey(yesterday)) return "\u062f\u06cc\u0631\u0648\u0632";
  return date.toLocaleDateString("fa-IR", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}
function ensureDaySeparator(timestamp) {
  const date = timestampDate(timestamp);
  if (!date) return;
  const container = messagesEl();
  const separators = container.querySelectorAll(".day-separator");
  const last = separators.length ? separators[separators.length - 1] : null;
  const key = localDayKey(date);
  if (last && last.dataset.day === key) return;
  const separator = el("div", "day-separator");
  separator.dataset.day = key;
  separator.appendChild(el("span", null, messageDayText(date)));
  container.appendChild(separator);
}
function appendMessageTime(parent, timestamp) {
  const date = timestampDate(timestamp);
  if (!date) return;
  const time = el("time", "message-time");
  time.dateTime = date.toISOString();
  time.textContent = messageTimeText(date);
  time.title = date.toLocaleString("fa-IR", { dateStyle: "full", timeStyle: "short" });
  parent.appendChild(time);
}

/* ------------------------------------------------------------------ *
 *  Message rendering
 * ------------------------------------------------------------------ */
function addUserMessage(text, timestamp, messageIndex) {
  ensureDaySeparator(timestamp);
  const wrap = el("div", "msg user");
  if (Number.isInteger(messageIndex)) wrap.dataset.messageIndex = String(messageIndex);
  const bubble = el("div", "bubble");
  bubble.textContent = text;
  bubble.dir = dirOf(text);
  wrap.appendChild(bubble);
  appendMessageTime(wrap, timestamp);
  messagesEl().appendChild(wrap);
  return wrap;
}
// Queue zone above the composer: shows messages waiting to run, each editable/removable.
function renderQueue() {
  const zone = $("#queue-zone");
  zone.innerHTML = "";
  if (state.searchOpen) { zone.hidden = true; return; }
  const items = state.queue || [];
  if (!items.length) { zone.hidden = true; return; }
  zone.hidden = false;
  zone.appendChild(el("div", "queue-label",
    `⏳ ${items.length} پیام در صف — قبل از اجرا می‌تونی ویرایش یا حذف کنی`));
  items.forEach((text, i) => {
    const row = el("div", "queue-item");
    const t = el("div", "queue-text");
    t.textContent = text; t.dir = dirOf(text);
    row.appendChild(t);
    const ed = el("button", "queue-btn", "✎");
    ed.title = "ویرایش";
    ed.onclick = () => {
      const v = prompt("ویرایش پیامِ در صف:", text);
      if (v !== null && v.trim()) wsSend({ type: "queue_edit", cid: state.viewCid, index: i, text: v });
    };
    const rm = el("button", "queue-btn danger", "×");
    rm.title = "حذف از صف";
    rm.onclick = () => wsSend({ type: "queue_remove", cid: state.viewCid, index: i });
    row.appendChild(ed);
    row.appendChild(rm);
    zone.appendChild(row);
  });
}
function startAssistant(cliText, timestamp, messageIndex, onFork) {
  ensureDaySeparator(timestamp);
  const wrap = el("div", "msg assistant");
  if (Number.isInteger(messageIndex)) wrap.dataset.messageIndex = String(messageIndex);
  const meta = el("div", "message-meta");
  meta.appendChild(el("div", "who", cliText || "دستیار"));
  appendMessageTime(meta, timestamp);
  if (onFork && Number.isInteger(messageIndex)) {
    const fork = el("button", "message-fork", "⧉");
    fork.type = "button";
    fork.title = "کپی گفتگو تا این پاسخ";
    fork.setAttribute("aria-label", fork.title);
    fork.onclick = (event) => {
      event.stopPropagation();
      onFork(fork);
    };
    meta.appendChild(fork);
  }
  wrap.appendChild(meta);
  const body = el("div", "body");
  wrap.appendChild(body);
  messagesEl().appendChild(wrap);
  return body;
}
function clearTyping(body) {
  const t = body && body.querySelector('[data-role="typing"]');
  if (t) t.remove();
}
function refreshTyping() {
  const body = state.assistantBody;
  if (!body) return;
  clearTyping(body);
  if (state.viewCid && state.busy.has(state.viewCid)) {
    const t = el("div", "typing", "<i></i><i></i><i></i>");
    t.dataset.role = "typing";
    body.appendChild(t);
  }
}
function appendEvent(body, ev) {
  clearTyping(body);
  switch (ev.type) {
    case "assistant":
      body.appendChild(el("div", "md", mdToHtml(ev.text)));
      break;
    case "thinking": {
      const d = el("details", "think");
      d.appendChild(el("summary", null, "استدلال"));
      d.appendChild(el("div", "inner md", mdToHtml(ev.text)));
      body.appendChild(d);
      break;
    }
    case "tool_use": {
      const d = el("details", "tool");
      d.appendChild(el("summary", null, `🔧 ${escapeHtml(ev.name || "ابزار")}`));
      const pre = el("pre");
      pre.textContent = ev.input && ev.input.command ? ev.input.command : JSON.stringify(ev.input || {}, null, 2);
      d.appendChild(pre);
      body.appendChild(d);
      break;
    }
    case "tool_result": {
      const d = el("details", "tool-res" + (ev.is_error ? " error" : ""));
      d.appendChild(el("summary", null, ev.is_error ? "خطای ابزار" : "خروجی ابزار"));
      const pre = el("pre");
      pre.textContent = ev.text || "";
      d.appendChild(pre);
      body.appendChild(d);
      break;
    }
    case "usage": {
      const parts = [];
      if (ev.input_tokens != null) parts.push(`in ${ev.input_tokens}`);
      if (ev.output_tokens != null) parts.push(`out ${ev.output_tokens}`);
      if (ev.cost_usd != null) parts.push(`$${Number(ev.cost_usd).toFixed(4)}`);
      if (parts.length) body.appendChild(el("div", "usage", "🎫 " + parts.join(" · ")));
      break;
    }
    case "error":
      body.appendChild(el("div", "err", escapeHtml(ev.text || "خطای نامشخص")));
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ *
 *  Sidebar (sessions grouped by project)
 * ------------------------------------------------------------------ */
function maxMtime(arr) { return arr.reduce((m, s) => Math.max(m, s.mtime || 0), 0); }
function conversationForEntry(entry) {
  if (entry.kind === "pending") return entry.value;
  const s = entry.value;
  return state.conversations.find((c) => c.cli === s.cli && c.session_id === s.session_id) || null;
}
function makeAttentionMark(title = "پاسخ خوانده‌نشده") {
  const mark = el("span", "attention-mark", "!");
  mark.title = title;
  mark.setAttribute("aria-label", title);
  return mark;
}

function renderSidebar() {
  const list = $("#session-list");
  list.innerHTML = "";

  // Conversations without a project are kept at the top. New conversations
  // created from a project are added to that project's group below.
  for (const c of state.conversations.filter((x) => !x.session_id && !x.cwd)) {
    list.appendChild(makeItem({
      cli: c.cli, title: c.title, subtitle: "جدید",
      active: state.viewCid === c.id, busy: state.busy.has(c.id),
      attention: c.needs_attention,
      onOpen: () => openConversation(c.id),
      onDelete: () => removeConversation(c.id),
    }));
  }

  // Existing sessions and pending conversations grouped by project directory.
  const groups = new Map();
  for (const s of state.ext) {
    const key = s.cwd || "—";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ kind: "session", value: s, mtime: s.mtime || 0 });
  }
  for (const c of state.conversations.filter((x) => !x.session_id && x.cwd)) {
    const key = c.cwd;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ kind: "pending", value: c, mtime: c.updated || c.created || 0 });
  }
  const keys = [...groups.keys()].sort((a, b) => maxMtime(groups.get(b)) - maxMtime(groups.get(a)));
  for (const cwd of keys) {
    const sessions = groups.get(cwd).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    const open = state.expanded.has(cwd);
    const head = el("div", "group-head" + (open ? " open" : ""));
    const info = el("div", "group-info");
    const titleRow = el("div", "group-title-row");
    const nm = el("span", "group-name");
    nm.textContent = baseName(cwd) || "—";
    titleRow.appendChild(nm);
    const groupBusy = sessions.some((entry) => {
      const conv = conversationForEntry(entry);
      return Boolean(conv && state.busy.has(conv.id));
    });
    const groupAttention = sessions.some((entry) => {
      const conv = conversationForEntry(entry);
      return Boolean(conv && conv.needs_attention);
    });
    if (groupBusy) {
      const spinner = el("span", "spin");
      spinner.title = "یک سشن در این پروژه در حال اجراست";
      titleRow.appendChild(spinner);
    }
    if (groupAttention) {
      titleRow.appendChild(makeAttentionMark("این پروژه پاسخ خوانده‌نشده دارد"));
    }
    info.appendChild(titleRow);
    const parent = parentPath(cwd);
    if (parent) info.appendChild(el("span", "group-path", parent));
    info.title = cwd;
    head.appendChild(info);
    const add = el("button", "group-new", "+");
    add.type = "button";
    add.title = "ایجاد گفتگوی جدید در این پروژه";
    add.setAttribute("aria-label", "ایجاد گفتگوی جدید در این پروژه");
    add.onclick = (e) => {
      e.stopPropagation();
      openCreateConversationModal(cwd === "—" ? state.workdir : cwd);
    };
    head.appendChild(add);
    head.appendChild(el("span", "group-count", sessions.length.toLocaleString("fa-IR")));
    head.onclick = () => { open ? state.expanded.delete(cwd) : state.expanded.add(cwd); renderSidebar(); };
    list.appendChild(head);
    if (open) {
      const body = el("div", "group-body");
      for (const entry of sessions) {
        body.appendChild(entry.kind === "pending" ? pendingItem(entry.value) : sessionItem(entry.value));
      }
      list.appendChild(body);
    }
  }

  if (!list.children.length) list.appendChild(el("div", "conv-sub", "سشنی پیدا نشد"));
}

function sessionItem(s) {
  const conv = state.conversations.find((c) => c.cli === s.cli && c.session_id === s.session_id);
  return makeItem({
    cli: s.cli, title: s.title, subtitle: timeStr(s.mtime),
    active: !!(conv && conv.id === state.viewCid),
    busy: !!(conv && state.busy.has(conv.id)),
    attention: !!(conv && conv.needs_attention),
    dot: s.goal_status,
    onOpen: () => (conv ? openConversation(conv.id) : openExternal(s)),
    onFork: () => forkSession(s),
    onRename: () => renameSession(s),
    onDelete: () => removeSession(s),
  });
}

function makeItem({ cli, title, subtitle, active, busy, attention, dot, onOpen, onFork, onRename, onDelete }) {
  const item = el("div", "conv" + (active ? " active" : ""));
  const main = el("div", "conv-main");
  const titleEl = el("div", "conv-title");
  const badge = el("span", "mini-badge" + (cli === "codex" ? " codex" : ""));
  badge.textContent = cliLabel(cli);
  titleEl.appendChild(badge);
  if (dot) {
    const d = el("span", "status-dot " + goalMeta(dot).cls);
    d.title = "هدف: " + goalMeta(dot).label;
    titleEl.appendChild(d);
  }
  if (busy) titleEl.appendChild(el("span", "spin"));
  else if (attention) titleEl.appendChild(makeAttentionMark());
  const text = el("span", "conv-title-text");
  const fullTitle = title || "بدون عنوان";
  text.textContent = fullTitle;
  text.title = fullTitle;
  titleEl.appendChild(text);
  main.appendChild(titleEl);
  main.appendChild(el("div", "conv-sub", subtitle || ""));
  item.appendChild(main);
  const actions = el("div", "conv-actions");
  if (onFork) {
    const fork = el("button", "conv-fork", "⧉");
    fork.title = "کپی / فورک سشن";
    fork.setAttribute("aria-label", fork.title);
    fork.onclick = (e) => { e.stopPropagation(); onFork(); };
    actions.appendChild(fork);
  }
  if (onRename) {
    const r = el("button", "conv-ren", "✎");
    r.title = "تغییر نام";
    r.onclick = (e) => { e.stopPropagation(); onRename(); };
    actions.appendChild(r);
  }
  if (onDelete) {
    const del = el("button", "conv-del", "×");
    del.title = "حذف";
    del.onclick = (e) => { e.stopPropagation(); onDelete(); };
    actions.appendChild(del);
  }
  if (actions.children.length) item.appendChild(actions);
  item.onclick = onOpen;
  return item;
}

async function renameSession(s) {
  const name = prompt("نام جدید برای این سشن:", s.title || "");
  if (name === null) return;
  await api("PUT", `/api/sessions/${s.cli}/${encodeURIComponent(s.session_id)}/name`, { name });
  await loadExternal();
  const conv = state.conversations.find((c) => c.cli === s.cli && c.session_id === s.session_id);
  if (conv && conv.id === state.viewCid) {
    const refreshed = state.ext.find((item) => item.cli === s.cli && item.session_id === s.session_id);
    const title = (name && name.trim()) || (refreshed && refreshed.title) || s.title;
    conv.title = title;
    setConversationHeading(title, (refreshed && refreshed.cwd) || s.cwd || conv.cwd);
    setPageTitle(title);
  }
}

async function forkSession(s, messageIndex = null, trigger = null) {
  const conv = state.conversations.find((c) => c.cli === s.cli && c.session_id === s.session_id);
  if (conv && state.busy.has(conv.id)) {
    alert("این سشن در حال اجراست؛ بعد از پایان نوبت دوباره تلاش کنید.");
    return;
  }
  if (trigger) trigger.disabled = true;
  try {
    const payload = Number.isInteger(messageIndex) ? { message_index: messageIndex } : {};
    const forked = await api(
      "POST",
      `/api/sessions/${s.cli}/${encodeURIComponent(s.session_id)}/fork`,
      payload,
    );
    if (!forked || forked.error || !forked.id) {
      throw new Error((forked && forked.error) || "فورک سشن انجام نشد.");
    }
    await loadConversations();
    await loadExternal();
    await openConversation(forked.id);
  } catch (err) {
    alert(err && err.message ? err.message : "فورک سشن انجام نشد.");
  } finally {
    if (trigger && trigger.isConnected) trigger.disabled = false;
  }
}

async function loadConfig() {
  const cfg = await api("GET", "/api/config");
  state.clis = cfg.clis || [];
  state.workdir = cfg.workdir || "";
}
async function loadConversations() {
  state.conversations = await api("GET", "/api/conversations");
  renderSidebar();
}
async function markConversationRead(id, force = false) {
  const conv = state.conversations.find((item) => item.id === id);
  if (!force && !(conv && conv.needs_attention)) return;
  if (conv) conv.needs_attention = false;
  renderSidebar();
  try {
    const result = await api("POST", `/api/conversations/${id}/read`, {});
    if (result && result.error) throw new Error(result.error);
  } catch (error) {
    if (conv) conv.needs_attention = true;
    renderSidebar();
  }
}
async function loadExternal() {
  try {
    const raw = await api("GET", "/api/sessions?cli=all");
    const seen = new Set();               // dedup by cli:session_id (belt-and-suspenders)
    state.ext = (raw || []).filter((s) => {
      const k = s.cli + ":" + s.session_id;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } catch (e) { state.ext = []; }
  if (!state._extInit && state.ext.length) {
    state._extInit = true;
    const newest = state.ext.reduce((a, b) => ((a.mtime || 0) >= (b.mtime || 0) ? a : b));
    state.expanded.add(newest.cwd || "—");
  }
  renderSidebar();
}
async function openExternal(s, historyMode = "push", messageIndex = null) {
  if (s.cwd) state.expanded.add(s.cwd);
  const conv = await api("POST", "/api/conversations/import", { cli: s.cli, session_id: s.session_id });
  if (conv && conv.id) {
    await loadConversations();
    await openConversation(conv.id, { historyMode, messageIndex });
    return true;
  }
  else {
    // Session no longer exists on disk — drop it from the list.
    state.ext = state.ext.filter((x) => !(x.cli === s.cli && x.session_id === s.session_id));
    renderSidebar();
    await loadExternal();
    return false;
  }
}
async function removeConversation(id) {
  if (!confirm("این گفتگوی جدید حذف شود؟")) return;
  await api("DELETE", "/api/conversations/" + id);
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (state.viewCid === id) resetView();
  await loadConversations();
  await loadExternal();
}
async function removeSession(s) {
  if (!confirm("حذف کامل این سشن؟ فایل ترنسکریپت واقعی Claude/Codex هم پاک می‌شود و قابل بازیابی نیست.")) return;
  await api("DELETE", `/api/sessions/${s.cli}/${encodeURIComponent(s.session_id)}`);
  const conv = state.conversations.find((c) => c.cli === s.cli && c.session_id === s.session_id);
  if (conv && state.viewCid === conv.id) resetView();
  await loadConversations();
  await loadExternal();
}

/* ------------------------------------------------------------------ *
 *  Open / view a conversation
 * ------------------------------------------------------------------ */
/* ---- goal + token/context usage (topbar) ---- */
function fmtTok(n) {
  if (n == null) return "";
  const value = Number(n);
  if (!Number.isFinite(value)) return "";
  const fa = (amount, maximumFractionDigits = 0) => amount.toLocaleString("fa-IR", { maximumFractionDigits });
  if (value >= 1e6) return `${fa(value / 1e6, 1)} میلیون`;
  if (value >= 1e3) return `${fa(value / 1e3, 1)} هزار`;
  return fa(Math.round(value));
}
const GOAL_STATUS = {
  active: { label: "در حال انجام", cls: "st-active" },
  complete: { label: "انجام‌شده", cls: "st-complete" },
  paused: { label: "متوقف", cls: "st-paused" },
  blocked: { label: "بلاک‌شده", cls: "st-blocked" },
  failed: { label: "ناموفق", cls: "st-blocked" },
};
function goalMeta(status) { return GOAL_STATUS[status] || { label: status || "—", cls: "st-other" }; }

function renderUsage(conv) {
  const box = $("#usage-info");
  box.innerHTML = "";
  box.dir = "rtl";
  if (conv.goal && conv.goal.status) {
    const m = goalMeta(conv.goal.status);
    const b = el("span", "goal-badge " + m.cls);
    b.textContent = "🎯 هدف: " + m.label;
    b.title = conv.goal.objective
      ? `وضعیت هدف: ${m.label} — ${conv.goal.objective}`
      : `وضعیت هدف: ${m.label}`;
    box.appendChild(b);
  }
  const u = conv.usage;
  if (u && u.context_tokens != null) {
    const pct = u.context_window
      ? Math.min(100, Math.round((u.context_tokens / u.context_window) * 100)) : null;
    const c = el("span", "usage-pill" + (pct != null && pct >= 85 ? " hot" : ""));
    c.textContent = pct != null
      ? `ظرفیت زمینه: ${pct.toLocaleString("fa-IR")}٪`
      : `زمینه: ${fmtTok(u.context_tokens)}`;
    c.title = u.context_window
      ? `مدل در آخرین نوبت ${fmtTok(u.context_tokens)} از ${fmtTok(u.context_window)} توکن ظرفیت زمینه را دیده است.`
      : "زمینه یعنی مقدار متنی که مدل در آخرین نوبت در اختیار داشته است.";
    box.appendChild(c);
  }
  if (u && u.fresh_tokens != null) {
    const t = el("span", "usage-pill");
    t.textContent = `پردازش جدید: ${fmtTok(u.fresh_tokens)}`;
    t.title = `توکن‌هایی که در کل جلسه از کش خوانده نشده‌اند و باید دوباره پردازش شوند: ${fmtTok(u.fresh_tokens)}. مجموع پردازش: ${fmtTok(u.processed_tokens)}.`;
    box.appendChild(t);
    if (u.last_fresh_tokens != null) {
      const last = el("span", "usage-pill");
      last.textContent = `آخرین نوبت: ${fmtTok(u.last_fresh_tokens)}`;
      last.title = `توکن‌های پردازش‌شده در آخرین رفت‌وبرگشت: ${fmtTok(u.last_fresh_tokens)}. این مقدار شامل ورودی، خروجی و ابزارهای همان نوبت است.`;
      box.appendChild(last);
    }
  } else if (u && u.total_tokens != null) {
    const t = el("span", "usage-pill");
    t.textContent = `پردازش کل: ${fmtTok(u.total_tokens)}`;
    t.title = "مجموع توکن‌های پردازش‌شده در این جلسه.";
    box.appendChild(t);
  }
  box.hidden = !box.children.length;
}

function codexDefaultsKey(cwd) {
  const path = trimmedPath(cwd);
  return /^[A-Za-z]:[\\/]/.test(path) ? path.toLowerCase() : path;
}

function pendingItem(c) {
  return makeItem({
    cli: c.cli, title: c.title, subtitle: "جدید",
    active: state.viewCid === c.id, busy: state.busy.has(c.id),
    attention: c.needs_attention,
    onOpen: () => openConversation(c.id),
    onDelete: () => removeConversation(c.id),
  });
}
function codexDefaultsFor(conv) {
  if (!conv || conv.cli !== "codex") return null;
  return state.codexDefaults.get(codexDefaultsKey(conv.cwd)) || null;
}
function codexModelLabel(modelId) {
  const info = (state.codexCatalog.models || []).find((model) => model.id === modelId);
  return info ? info.display_name : modelId;
}
function modelOptions(conv) {
  const cli = conv.cli;
  const list = state.models[cli] || [];
  const catalog = new Map((state.codexCatalog.models || []).map((model) => [model.id, model]));
  const defaults = codexDefaultsFor(conv);
  const defaultLabel = defaults && defaults.model
    ? `پیش‌فرض (${codexModelLabel(defaults.model)})`
    : "پیش‌فرض";
  const defaultDescription = cli === "codex" ? "تنظیم مؤثر Codex برای این پروژه" : "";
  return [{ id: "", label: defaultLabel, description: defaultDescription }].concat(
    list.map((id) => {
      const info = cli === "codex" ? catalog.get(id) : null;
      return { id, label: info ? info.display_name : id, description: info ? info.description : "" };
    }),
  );
}
const EFFORT_LABELS = {
  minimal: "حداقل (minimal)", low: "کم (low)", medium: "متوسط (medium)",
  high: "زیاد (high)", xhigh: "خیلی زیاد (xhigh)", max: "حداکثر (max)",
  ultra: "اولترا (ultra)",
};
const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh"].map((id) => ({ id, description: "" }));
function effortOptions(conv, modelId = conv.model || "") {
  const models = state.codexCatalog.models || [];
  const effectiveModel = modelId || (codexDefaultsFor(conv) || {}).model || "";
  const info = effectiveModel
    ? models.find((model) => model.id === effectiveModel)
    : models.find((model) => model.is_default);
  return info && info.efforts && info.efforts.length ? info.efforts : FALLBACK_EFFORTS;
}
function renderEffortSelect(conv) {
  const label = $("#effort-label");
  const sel = $("#effort-select");
  if (conv.cli !== "codex") {
    label.hidden = true;
    sel.hidden = true;
    sel.onchange = null;
    return;
  }
  const options = effortOptions(conv);
  const current = conv.reasoning_effort || "";
  const defaults = codexDefaultsFor(conv);
  sel.innerHTML = "";
  const defaultOption = el("option");
  defaultOption.value = "";
  defaultOption.textContent = defaults && defaults.reasoning_effort
    ? `پیش‌فرض (${defaults.reasoning_effort})`
    : "پیش‌فرض";
  sel.appendChild(defaultOption);
  for (const effort of options) {
    const option = el("option");
    option.value = effort.id;
    option.textContent = EFFORT_LABELS[effort.id] || effort.id;
    option.title = effort.description || "";
    if (current === effort.id) option.selected = true;
    sel.appendChild(option);
  }
  if (current && !options.some((effort) => effort.id === current)) {
    const unsupported = el("option");
    unsupported.value = current;
    unsupported.textContent = `${EFFORT_LABELS[current] || current} (پشتیبانی‌نشده)`;
    unsupported.selected = true;
    sel.appendChild(unsupported);
  }
  label.hidden = false;
  sel.hidden = false;
  sel.onchange = async () => {
    const updated = await api("PATCH", "/api/conversations/" + conv.id, { reasoning_effort: sel.value });
    if (!updated || updated.error) return;
    conv.reasoning_effort = updated.reasoning_effort;
    const saved = state.conversations.find((item) => item.id === conv.id);
    if (saved) saved.reasoning_effort = updated.reasoning_effort;
  };
}
function renderModelSelect(conv) {
  const sel = $("#model-select");
  sel.innerHTML = "";
  const options = modelOptions(conv);
  if (conv.model && !options.some((model) => model.id === conv.model)) {
    options.splice(1, 0, {
      id: conv.model,
      label: `${conv.model} (ذخیره‌شده)`,
      description: "این مدل دیگر در فهرست فعلی Codex نمایش داده نمی‌شود.",
    });
  }
  for (const m of options) {
    const o = el("option");
    o.value = m.id;
    o.textContent = m.label;
    o.title = m.description || "";
    if ((conv.model || "") === m.id) o.selected = true;
    sel.appendChild(o);
  }
  sel.hidden = false;
  $("#model-label").hidden = false;
  renderEffortSelect(conv);
  sel.onchange = async () => {
    const supported = effortOptions(conv, sel.value);
    const patch = { model: sel.value };
    if (conv.reasoning_effort && !supported.some((item) => item.id === conv.reasoning_effort)) {
      patch.reasoning_effort = "";
    }
    const updated = await api("PATCH", "/api/conversations/" + conv.id, patch);
    if (!updated || updated.error) return;
    conv.model = updated.model;
    conv.reasoning_effort = updated.reasoning_effort;
    const saved = state.conversations.find((item) => item.id === conv.id);
    if (saved) {
      saved.model = updated.model;
      saved.reasoning_effort = updated.reasoning_effort;
    }
    renderEffortSelect(conv);
  };
}
async function loadModels(forceRefresh = false) {
  try {
    state.models = await api("GET", "/api/models" + (forceRefresh ? "?refresh=true" : ""));
    state.codexCatalog = (state.models._catalog || {}).codex || { source: "fallback", models: [], error: null };
  } catch (e) {
    state.models = {};
    state.codexCatalog = { source: "fallback", models: [], error: String(e) };
  }
}
async function loadCodexDefaults(conv, forceRefresh = false) {
  if (!conv || conv.cli !== "codex" || !conv.cwd) return null;
  const key = codexDefaultsKey(conv.cwd);
  if (!forceRefresh && state.codexDefaults.has(key)) return state.codexDefaults.get(key);
  const suffix = forceRefresh ? "&refresh=true" : "";
  try {
    const defaults = await api("GET", `/api/codex/defaults?cwd=${encodeURIComponent(conv.cwd)}${suffix}`);
    if (!defaults || (defaults.error && !defaults.model)) return null;
    state.codexDefaults.set(key, defaults);
    return defaults;
  } catch (e) {
    return null;
  }
}

function createFormField(labelText, control) {
  const field = el("label", "create-field");
  field.appendChild(el("span", "create-label", labelText));
  field.appendChild(control);
  return field;
}

function renderCreateModelFields(draft, modelSelect, effortField, effortSelect) {
  const options = modelOptions(draft);
  modelSelect.innerHTML = "";
  for (const model of options) {
    const option = el("option");
    option.value = model.id;
    option.textContent = model.label;
    option.title = model.description || "";
    if ((draft.model || "") === model.id) option.selected = true;
    modelSelect.appendChild(option);
  }
  if (![...modelSelect.options].some((option) => option.value === (draft.model || ""))) {
    draft.model = "";
    modelSelect.value = "";
  }

  effortField.hidden = draft.cli !== "codex";
  effortSelect.innerHTML = "";
  if (draft.cli !== "codex") {
    draft.reasoning_effort = "";
    return;
  }
  const defaultOption = el("option");
  defaultOption.value = "";
  const defaults = codexDefaultsFor(draft);
  defaultOption.textContent = defaults && defaults.reasoning_effort
    ? `پیش‌فرض (${defaults.reasoning_effort})` : "پیش‌فرض";
  effortSelect.appendChild(defaultOption);
  const efforts = effortOptions(draft, draft.model || "");
  if (draft.reasoning_effort && !efforts.some((effort) => effort.id === draft.reasoning_effort)) {
    draft.reasoning_effort = "";
  }
  for (const effort of efforts) {
    const option = el("option");
    option.value = effort.id;
    option.textContent = EFFORT_LABELS[effort.id] || effort.id;
    option.title = effort.description || "";
    if (draft.reasoning_effort === effort.id) option.selected = true;
    effortSelect.appendChild(option);
  }
}

async function browseForProject() {
  const button = $("#browse-btn");
  button.disabled = true;
  button.textContent = "📁 در حال انتخاب…";
  try {
    const result = await api("POST", "/api/browse-directory");
    if (result && result.path) {
      openCreateConversationModal(result.path);
    } else if (result && result.error) {
      alert(result.error);
    }
  } catch (e) {
    alert("انتخاب پوشه انجام نشد. مطمئن شوید سرور محلی در حال اجراست.");
  } finally {
    button.disabled = false;
    button.textContent = "📁 انتخاب پروژه";
  }
}

function openCreateConversationModal(cwd) {
  const projectPath = cwd || state.workdir || "";
  const draft = { cli: "codex", cwd: projectPath, model: "", reasoning_effort: "" };
  const availableClis = state.clis.length ? state.clis : [
    { id: "claude", label: "Claude" }, { id: "codex", label: "Codex" },
  ];
  $("#modal-title").textContent = "ایجاد گفتگوی جدید";
  const body = $("#modal-body");
  body.innerHTML = "";

  const form = el("form", "create-form");
  form.setAttribute("dir", "rtl");
  const project = el("div", "create-project");
  project.appendChild(el("span", "create-label", "پروژه"));
  const path = el("span", "create-project-path", projectPath || "مسیر پیش‌فرض");
  path.title = projectPath;
  project.appendChild(path);
  form.appendChild(project);

  const titleInput = el("input");
  titleInput.type = "text";
  titleInput.required = true;
  titleInput.maxLength = 200;
  titleInput.placeholder = "مثلاً: پیاده‌سازی قابلیت جستجو";
  form.appendChild(createFormField("عنوان گفتگو", titleInput));

  const cliSelect = el("select");
  for (const cli of availableClis) {
    const option = el("option");
    option.value = cli.id;
    option.textContent = cli.label + (cli.configured === false ? " (تنظیم‌نشده)" : "");
    cliSelect.appendChild(option);
  }
  cliSelect.value = draft.cli;
  form.appendChild(createFormField("موتور", cliSelect));

  const modelSelect = el("select");
  const effortSelect = el("select");
  const effortField = createFormField("میزان effort", effortSelect);
  form.appendChild(createFormField("مدل", modelSelect));
  form.appendChild(effortField);
  renderCreateModelFields(draft, modelSelect, effortField, effortSelect);

  const error = el("div", "create-error");
  error.hidden = true;
  form.appendChild(error);
  const actions = el("div", "create-actions");
  const cancel = el("button", "create-cancel", "انصراف");
  cancel.type = "button";
  cancel.onclick = closeModal;
  const submit = el("button", "create-submit", "ایجاد گفتگو");
  submit.type = "submit";
  actions.append(cancel, submit);
  form.appendChild(actions);
  body.appendChild(form);
  $("#modal").hidden = false;

  cliSelect.onchange = async () => {
    draft.cli = cliSelect.value;
    draft.model = "";
    draft.reasoning_effort = "";
    renderCreateModelFields(draft, modelSelect, effortField, effortSelect);
    if (draft.cli === "codex") {
      await loadCodexDefaults(draft);
      if (form.isConnected) renderCreateModelFields(draft, modelSelect, effortField, effortSelect);
    }
  };
  modelSelect.onchange = () => {
    draft.model = modelSelect.value;
    draft.reasoning_effort = "";
    renderCreateModelFields(draft, modelSelect, effortField, effortSelect);
  };
  effortSelect.onchange = () => { draft.reasoning_effort = effortSelect.value; };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const title = titleInput.value.trim();
    if (!title) { titleInput.focus(); return; }
    submit.disabled = true;
    error.hidden = true;
    let conv;
    try {
      conv = await api("POST", "/api/conversations", {
        title, cli: draft.cli, cwd: draft.cwd || null,
        model: draft.model || null,
        reasoning_effort: draft.cli === "codex" ? (draft.reasoning_effort || null) : null,
      });
    } catch (e) {
      conv = { error: "ارتباط با سرور برقرار نشد." };
    }
    if (!conv || conv.error) {
      error.textContent = (conv && conv.error) || "خطا در ساخت گفتگو";
      error.hidden = false;
      submit.disabled = false;
      return;
    }
    closeModal();
    if (draft.cwd) state.expanded.add(draft.cwd);
    await loadConversations();
    await openConversation(conv.id);
  };
  setTimeout(() => titleInput.focus(), 0);

  // Fetch the project-specific Codex defaults after the modal is visible.
  loadCodexDefaults(draft).then(() => {
    if (form.isConnected && draft.cli === "codex") {
      renderCreateModelFields(draft, modelSelect, effortField, effortSelect);
    }
  });
}

/* ---- models manager modal ---- */
function openModelsModal() {
  $("#modal-title").textContent = "مدیریت لیست مدل‌ها";
  const body = $("#modal-body");
  body.innerHTML = "";
  for (const cli of state.clis) {
    const sec = el("div", "model-sec");
    const head = el("div", "model-sec-head");
    head.appendChild(el("div", "model-sec-title", cli.label));
    const liveCodex = cli.id === "codex" && state.codexCatalog.source === "codex";
    if (cli.id === "codex") {
      const refresh = el("button", "catalog-refresh", "دریافت دوباره از Codex");
      refresh.onclick = async () => {
        refresh.disabled = true;
        refresh.textContent = "در حال دریافت…";
        await loadModels(true);
        const conv = state.conversations.find((item) => item.id === state.viewCid);
        if (conv) {
          await loadCodexDefaults(conv, true);
          renderModelSelect(conv);
        }
        openModelsModal();
      };
      head.appendChild(refresh);
    }
    sec.appendChild(head);
    if (cli.id === "codex") {
      const note = liveCodex
        ? "این فهرست و effortهای هر مدل مستقیماً از Codex دریافت شده‌اند."
        : "Codex در دسترس نبود؛ فهرست ذخیره‌شده نمایش داده می‌شود و قابل ویرایش است.";
      const noteEl = el("div", "catalog-note", note);
      if (state.codexCatalog.error) noteEl.title = state.codexCatalog.error;
      sec.appendChild(noteEl);
    }
    const chips = el("div", "chips");
    const list = state.models[cli.id] || [];
    for (const m of list) {
      const chip = el("span", "chip");
      const info = liveCodex
        ? (state.codexCatalog.models || []).find((model) => model.id === m)
        : null;
      chip.appendChild(document.createTextNode(info ? info.display_name : m));
      chip.title = info ? `${m}${info.description ? " — " + info.description : ""}` : m;
      if (!liveCodex) {
        const x = el("button", "chip-x", "×");
        x.onclick = () => removeModel(cli.id, m);
        chip.appendChild(x);
      }
      chips.appendChild(chip);
    }
    if (!list.length) chips.appendChild(el("span", "conv-sub", "مدلی اضافه نشده"));
    sec.appendChild(chips);
    if (!liveCodex) {
      const row = el("div", "add-row");
      const inp = el("input", "add-input");
      inp.placeholder = "نام مدل جدید…";
      const add = el("button", "add-btn", "افزودن");
      const doAdd = () => { const v = inp.value.trim(); if (v) addModel(cli.id, v); };
      add.onclick = doAdd;
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });
      row.append(inp, add);
      sec.appendChild(row);
    }
    body.appendChild(sec);
  }
  $("#modal").hidden = false;
}
function closeModal() { $("#modal").hidden = true; }
function statsDateText(dateKey) {
  const parts = String(dateKey).split("-").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return dateKey;
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  return date.toLocaleDateString("fa-IR", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}
function renderConversationStats(stats) {
  const body = $("#modal-body");
  body.innerHTML = "";
  const total = Number(stats.total_turns) || 0;
  const activeDays = Number(stats.active_days) || 0;

  const summary = el("div", "stats-summary");
  const totalItem = el("span");
  totalItem.append(el("strong", null, total.toLocaleString("fa-IR")), document.createTextNode(" رفت‌وبرگشت"));
  const daysItem = el("span");
  daysItem.append(el("strong", null, activeDays.toLocaleString("fa-IR")), document.createTextNode(" روز فعال"));
  summary.append(totalItem, daysItem);
  body.appendChild(summary);

  const days = (stats.days || []).slice();
  if (stats.undated_turns) days.push({ date: null, turns: stats.undated_turns });
  if (!days.length) {
    body.appendChild(el("div", "stats-empty", "هنوز رفت‌وبرگشتی در این گفتگو ثبت نشده است."));
    return;
  }

  const maxTurns = Math.max(...days.map((day) => Number(day.turns) || 0), 1);
  const list = el("div", "stats-list");
  for (const day of days) {
    const turns = Number(day.turns) || 0;
    const row = el("div", "stats-row");
    const dateLabel = day.date ? statsDateText(day.date) : "تاریخ نامشخص";
    const date = el("div", "stats-date", dateLabel);
    date.title = dateLabel;
    row.appendChild(date);
    const track = el("div", "stats-track");
    const bar = el("div", "stats-bar");
    bar.style.width = `${Math.max(4, (turns / maxTurns) * 100)}%`;
    track.appendChild(bar);
    row.appendChild(track);
    row.appendChild(el("div", "stats-count", turns.toLocaleString("fa-IR")));
    list.appendChild(row);
  }
  body.appendChild(list);
}
async function openConversationStats() {
  if (!state.viewCid) return;
  const button = $("#stats-btn");
  button.disabled = true;
  $("#modal-title").textContent = "آمار گفتگو";
  $("#modal-body").innerHTML = "<div class='stats-empty'>در حال محاسبه…</div>";
  $("#modal").hidden = false;
  try {
    const stats = await api("GET", `/api/conversations/${state.viewCid}/stats`);
    if (!stats || stats.error) throw new Error((stats && stats.error) || "stats unavailable");
    renderConversationStats(stats);
  } catch (e) {
    $("#modal-body").innerHTML = "<div class='stats-empty error-text'>نمایش آمار ممکن نشد.</div>";
  } finally {
    button.disabled = false;
  }
}
async function saveModels(cli, models) {
  state.models = await api("PUT", "/api/models/" + cli, { models });
  openModelsModal();
  const conv = state.conversations.find((c) => c.id === state.viewCid);
  if (conv) renderModelSelect(conv);
}
function addModel(cli, name) {
  const list = (state.models[cli] || []).slice();
  if (!list.includes(name)) list.push(name);
  saveModels(cli, list);
}
function removeModel(cli, name) {
  saveModels(cli, (state.models[cli] || []).filter((m) => m !== name));
}

/* ---- transcript search ---- */
function selectedConversation() {
  return state.conversations.find((conv) => conv.id === state.viewCid) || null;
}
function setSearchScope(scope) {
  const conv = selectedConversation();
  if (scope === "project" && !(conv && conv.cwd)) scope = "all";
  if (scope === "session" && !(conv && conv.session_id)) scope = "all";
  state.searchScope = scope;
  for (const button of document.querySelectorAll("#search-scopes button")) {
    const active = button.dataset.scope === scope;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = (
      (button.dataset.scope === "project" && !(conv && conv.cwd))
      || (button.dataset.scope === "session" && !(conv && conv.session_id))
    );
  }
}
function setSearchOpen(open) {
  state.searchOpen = Boolean(open);
  $("#search-view").hidden = !state.searchOpen;
  $("#messages").hidden = state.searchOpen;
  $("#composer").hidden = state.searchOpen;
  $("#search-btn").classList.toggle("active", state.searchOpen);
  $("#search-btn").setAttribute("aria-pressed", String(state.searchOpen));
  setSearchScope(state.searchScope);
  renderQueue();
  if (state.searchOpen) {
    if (!$("#search-results").children.length) {
      $("#search-results").appendChild(el("div", "search-empty", "جستجویی انجام نشده است."));
    }
    $("#search-input").focus();
  } else {
    scrollDown();
  }
}
function searchTimeText(timestamp) {
  const date = timestampDate(timestamp);
  return date ? date.toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" }) : "";
}
function appendHighlightedText(parent, text, query) {
  const escaped = String(query || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) { parent.textContent = text; return; }
  const pattern = new RegExp(escaped, "gi");
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    parent.appendChild(el("mark", null, match[0]));
    cursor = match.index + match[0].length;
  }
  if (!cursor) { parent.textContent = text; return; }
  if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)));
}
function searchResultUrl(hit) {
  const url = new URL(window.location.href);
  url.searchParams.set(SESSION_URL_PARAM, hit.session_id);
  url.searchParams.set(MESSAGE_URL_PARAM, String(hit.message_index));
  return url.toString();
}
function searchCollapseButton(collapsed, label, onToggle) {
  const button = el("button", "search-collapse", collapsed ? "▸" : "▾");
  button.type = "button";
  button.title = collapsed ? `باز کردن ${label}` : `جمع کردن ${label}`;
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-expanded", String(!collapsed));
  button.onclick = onToggle;
  return button;
}
function renderSearchResults(payload, query) {
  const container = $("#search-results");
  container.innerHTML = "";
  const results = payload.results || [];
  const resultCount = results.length.toLocaleString("fa-IR");
  const matchedCount = Number(payload.matched_sessions || 0).toLocaleString("fa-IR");
  const searchedCount = Number(payload.searched_sessions || 0).toLocaleString("fa-IR");
  $("#search-meta").textContent = `${resultCount} نتیجه در ${matchedCount} سشن · ${searchedCount} سشن بررسی شد${payload.truncated ? " · نتایج محدود شده‌اند" : ""}`;
  if (!results.length) {
    container.appendChild(el("div", "search-empty", "نتیجه‌ای پیدا نشد."));
    return;
  }

  const projects = new Map();
  for (const result of results) {
    const projectKey = result.cwd || "—";
    if (!projects.has(projectKey)) projects.set(projectKey, new Map());
    const sessions = projects.get(projectKey);
    const sessionKey = `${result.cli}:${result.session_id}`;
    if (!sessions.has(sessionKey)) sessions.set(sessionKey, { result, hits: [] });
    sessions.get(sessionKey).hits.push(result);
  }

  for (const [project, sessions] of projects) {
    const projectSection = el("section", "search-project");
    const projectHead = el("div", "search-project-head");
    const projectCollapsed = state.collapsedSearchProjects.has(project);
    const projectName = el("span", "search-project-name");
    projectName.textContent = baseName(project) || "—";
    projectHead.appendChild(projectName);
    const parent = parentPath(project);
    if (parent) {
      const projectPath = el("span", "search-project-path");
      projectPath.textContent = parent;
      projectHead.appendChild(projectPath);
    }
    projectHead.title = project;
    const projectBody = el("div", "search-project-body");
    projectBody.hidden = projectCollapsed;
    const projectToggle = searchCollapseButton(projectCollapsed, "پروژه", () => {
      const collapsed = !projectBody.hidden;
      projectBody.hidden = collapsed;
      if (collapsed) state.collapsedSearchProjects.add(project);
      else state.collapsedSearchProjects.delete(project);
      projectToggle.textContent = collapsed ? "▸" : "▾";
      projectToggle.title = collapsed ? "باز کردن پروژه" : "جمع کردن پروژه";
      projectToggle.setAttribute("aria-label", projectToggle.title);
      projectToggle.setAttribute("aria-expanded", String(!collapsed));
    });
    projectHead.appendChild(projectToggle);
    projectSection.appendChild(projectHead);

    for (const { result, hits } of sessions.values()) {
      const session = el("section", "search-session");
      const head = el("div", "search-session-head");
      const sessionKey = `${result.cli}:${result.session_id}`;
      const sessionCollapsed = state.collapsedSearchSessions.has(sessionKey);
      const badge = el("span", "mini-badge" + (result.cli === "codex" ? " codex" : ""), cliLabel(result.cli));
      head.appendChild(badge);
      const title = el("div", "search-session-title");
      title.textContent = result.title || "بدون عنوان";
      title.title = title.textContent;
      head.appendChild(title);
      head.appendChild(el("div", "search-session-count", hits.length.toLocaleString("fa-IR")));
      const sessionBody = el("div", "search-session-body");
      sessionBody.hidden = sessionCollapsed;
      const sessionToggle = searchCollapseButton(sessionCollapsed, "سشن", () => {
        const collapsed = !sessionBody.hidden;
        sessionBody.hidden = collapsed;
        if (collapsed) state.collapsedSearchSessions.add(sessionKey);
        else state.collapsedSearchSessions.delete(sessionKey);
        sessionToggle.textContent = collapsed ? "▸" : "▾";
        sessionToggle.title = collapsed ? "باز کردن سشن" : "جمع کردن سشن";
        sessionToggle.setAttribute("aria-label", sessionToggle.title);
        sessionToggle.setAttribute("aria-expanded", String(!collapsed));
      });
      head.appendChild(sessionToggle);
      session.appendChild(head);

      for (const hit of hits) {
        const row = el("div", "search-result-row");
        const resultLink = el("a", "search-result");
        resultLink.href = searchResultUrl(hit);
        resultLink.appendChild(el("span", "search-role", hit.role === "user" ? "کاربر" : "دستیار"));
        const snippet = el("span", "search-snippet");
        appendHighlightedText(snippet, hit.snippet || "", query);
        resultLink.appendChild(snippet);
        resultLink.appendChild(el("time", "search-time", searchTimeText(hit.timestamp)));
        resultLink.onclick = (event) => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          openSearchResult(hit);
        };
        row.appendChild(resultLink);
        const newTab = el("a", "search-open-new", "↗");
        newTab.href = resultLink.href;
        newTab.target = "_blank";
        newTab.rel = "noopener";
        newTab.title = "باز کردن در تب جدید";
        newTab.setAttribute("aria-label", "باز کردن نتیجه در تب جدید");
        row.appendChild(newTab);
        sessionBody.appendChild(row);
      }
      session.appendChild(sessionBody);
      projectBody.appendChild(session);
    }
    projectSection.appendChild(projectBody);
    container.appendChild(projectSection);
  }
}
async function runTranscriptSearch() {
  const query = $("#search-input").value.trim();
  if (query.length < 2) {
    $("#search-meta").textContent = "";
    $("#search-results").innerHTML = "<div class='search-empty'>عبارت جستجو خیلی کوتاه است.</div>";
    return;
  }
  const conv = selectedConversation();
  setSearchScope(state.searchScope);
  const params = new URLSearchParams({ q: query, scope: state.searchScope, limit: "100" });
  if (state.searchScope === "project") params.set("project", conv.cwd);
  if (state.searchScope === "session") params.set("session_id", conv.session_id);

  const requestId = ++state.searchRequest;
  $("#search-meta").textContent = "در حال جستجو…";
  $("#search-results").innerHTML = "";
  try {
    const payload = await api("GET", "/api/search?" + params.toString());
    if (requestId !== state.searchRequest) return;
    if (!payload || payload.error) throw new Error((payload && payload.error) || "search failed");
    renderSearchResults(payload, query);
  } catch (e) {
    if (requestId !== state.searchRequest) return;
    $("#search-meta").textContent = "";
    $("#search-results").innerHTML = "<div class='search-empty error-text'>جستجو انجام نشد.</div>";
  }
}
async function openSearchResult(hit) {
  let conv = state.conversations.find(
    (item) => item.cli === hit.cli && item.session_id === hit.session_id,
  );
  if (!conv) {
    const imported = await api("POST", "/api/conversations/import", {
      cli: hit.cli,
      session_id: hit.session_id,
    });
    if (!imported || !imported.id) return;
    await loadConversations();
    conv = state.conversations.find((item) => item.id === imported.id) || imported;
  }
  await openConversation(conv.id, { messageIndex: hit.message_index });
}

function resetView() {
  if (state.viewCid) wsSend({ type: "close", cid: state.viewCid });
  state.viewCid = null;
  state.assistantBody = null;
  setConversationHeading("گفتگویی انتخاب نشده");
  setPageTitle();
  clearSessionUrl();
  $("#stats-btn").hidden = true;
  $("#conv-cli-badge").hidden = true;
  $("#model-label").hidden = true;
  $("#model-select").hidden = true;
  $("#effort-label").hidden = true;
  $("#effort-select").hidden = true;
  $("#usage-info").hidden = true; $("#usage-info").innerHTML = "";
  messagesEl().innerHTML = "<div class='empty'><div class='empty-emoji'>💬</div><p>گفتگویی انتخاب نشده.</p></div>";
  updateComposer();
  renderSidebar();
}
const RENDER_CAP = 50;  // render only the latest N messages for snappy switching
function renderOneMessage(conv, msg, messageIndex) {
  if (msg.role === "user") addUserMessage(msg.text || "", msg.timestamp, messageIndex);
  else if (msg.role === "assistant") {
    const body = startAssistant(
      cliLabel(conv.cli),
      msg.timestamp,
      messageIndex,
      conv.session_id ? (trigger) => forkSession(conv, messageIndex, trigger) : null,
    );
    clearTyping(body);
    for (const ev of msg.events || []) appendEvent(body, ev);
  }
}
function renderMessages(conv, targetMessageIndex = null) {
  const m = messagesEl();
  m.innerHTML = "";
  const all = conv.messages || [];
  const capMessages = !Number.isInteger(targetMessageIndex) && all.length > RENDER_CAP;
  const shown = capMessages ? all.slice(-RENDER_CAP) : all;
  const shownOffset = (conv.truncated ? (conv.total || 0) - all.length : 0) + (all.length - shown.length);
  const hidden = conv.truncated ? ((conv.total || 0) - shown.length) : (all.length - shown.length);
  if (hidden > 0) {
    const b = el("div", "load-earlier");
    b.textContent = `⬆️ نمایش پیام‌های قبلی (${hidden})`;
    b.onclick = () => loadEarlier(conv, b);
    m.appendChild(b);
  }
  shown.forEach((msg, index) => renderOneMessage(conv, msg, shownOffset + index));
}
async function loadEarlier(conv, btn) {
  if (btn) btn.textContent = "… در حال بارگذاری";
  let all = conv.messages || [];
  if (conv.truncated) {
    const full = await api("GET", "/api/conversations/" + conv.id + "?limit=0");
    if (full && !full.error) all = full.messages || all;
  }
  const m = messagesEl();
  m.innerHTML = "";
  all.forEach((msg, index) => renderOneMessage(conv, msg, index));
  m.scrollTop = 0;
}

async function openConversation(id, { historyMode = "push", messageIndex = null } = {}) {
  setSearchOpen(false);
  if (state.viewCid && state.viewCid !== id) wsSend({ type: "close", cid: state.viewCid });
  state.viewCid = id;
  state.assistantBody = null;
  $("#stats-btn").hidden = true;
  state.queue = []; renderQueue();
  const limit = Number.isInteger(messageIndex) ? 0 : 50;
  const conv = await api("GET", `/api/conversations/${id}?limit=${limit}`);
  if (!conv || conv.error) {
    // Stale/ghost item (deleted server-side) — drop it and re-sync so it stops showing.
    state.conversations = state.conversations.filter((c) => c.id !== id);
    state.viewCid = null;
    resetView();
    await loadConversations();
    await loadExternal();
    return;
  }
  await markConversationRead(id, Boolean(conv.needs_attention));
  conv.needs_attention = false;
  if (conv.cwd) state.expanded.add(conv.cwd);
  setConversationHeading(conv.title || "گفتگو", conv.cwd);
  setPageTitle(conv.title || "گفتگو");
  updateSessionUrl(conv, historyMode, messageIndex);
  $("#stats-btn").hidden = false;
  const badge = $("#conv-cli-badge");
  badge.hidden = false;
  badge.textContent = cliLabel(conv.cli);
  badge.className = "badge" + (conv.cli === "codex" ? " codex" : "");
  await loadCodexDefaults(conv);
  renderModelSelect(conv);
  renderUsage(conv);
  renderSidebar();

  renderMessages(conv, messageIndex);
  if (Number.isInteger(messageIndex)) {
    const target = messagesEl().querySelector(`[data-message-index="${messageIndex}"]`);
    if (target) {
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: "center" });
        target.classList.add("search-target");
        setTimeout(() => target.classList.remove("search-target"), 2800);
      });
    }
  } else {
    scrollDown();
  }
  updateComposer();
  wsSend({ type: "open", cid: id }); // subscribe -> server replays any in-progress turn
}

async function restoreConversationFromUrl(historyMode = "replace") {
  const key = sessionKeyFromUrl();
  if (!key) return false;

  const conv = state.conversations.find((item) => item.session_id === key || item.id === key);
  if (conv) {
    await openConversation(conv.id, { historyMode, messageIndex: messageIndexFromUrl() });
    return state.viewCid === conv.id;
  }

  const external = state.ext.find((item) => item.session_id === key);
  if (external) return openExternal(external, historyMode, messageIndexFromUrl());

  clearSessionUrl();
  setPageTitle();
  return false;
}

/* ------------------------------------------------------------------ *
 *  Global WebSocket (turns run in the background, server-side)
 * ------------------------------------------------------------------ */
function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}
function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    // Re-sync the sidebar on every (re)connect so ghosts from an interrupted
    // turn or a server restart clear themselves.
    loadConversations();
    loadExternal();
    if (state.viewCid) wsSend({ type: "open", cid: state.viewCid });
  };
  ws.onmessage = (e) => handleEvent(JSON.parse(e.data));
  ws.onclose = () => { state.ws = null; setTimeout(connectWs, 1000); };
}
function updateComposer() {
  const busy = state.viewCid && state.busy.has(state.viewCid);
  $("#send-btn").disabled = !state.viewCid;      // allow queueing a message while busy
  $("#stop-btn").hidden = !busy;
}
function handleEvent(ev) {
  switch (ev.type) {
    case "init-status":
      state.busy = new Set(ev.busy || []);
      renderSidebar(); updateComposer(); return;
    case "status":
      if (ev.busy) state.busy.add(ev.cid); else state.busy.delete(ev.cid);
      if (Object.prototype.hasOwnProperty.call(ev, "needs_attention")) {
        const conv = state.conversations.find((item) => item.id === ev.cid);
        const needsAttention = Boolean(ev.needs_attention && ev.cid !== state.viewCid);
        if (conv) conv.needs_attention = needsAttention;
        if (ev.needs_attention && ev.cid === state.viewCid) {
          markConversationRead(ev.cid, true);
        }
      }
      renderSidebar();
      if (ev.cid === state.viewCid) { updateComposer(); refreshTyping(); }
      if (!ev.busy) { loadConversations(); loadExternal(); }
      return;
    case "attention": {
      const c = state.conversations.find((item) => item.id === ev.cid);
      if (c) c.needs_attention = Boolean(ev.needs_attention);
      renderSidebar(); return;
    }
    case "title": {
      const c = state.conversations.find((x) => x.id === ev.cid);
      if (c) c.title = ev.title;
      if (ev.cid === state.viewCid) {
        setConversationHeading(ev.title, c && c.cwd);
        setPageTitle(ev.title);
      }
      renderSidebar(); return;
    }
    case "session": {
      const c = state.conversations.find((x) => x.id === ev.cid);
      if (c) c.session_id = ev.session_id;
      if (c && ev.cid === state.viewCid) updateSessionUrl(c, "replace");
      if (state.searchOpen) setSearchScope(state.searchScope);
      return;
    }
    case "queued":
      if (ev.cid === state.viewCid) { state.queue = ev.items || []; renderQueue(); }
      return;
  }
  if (ev.cid && ev.cid !== state.viewCid) return; // stream event for another view
  handleStreamEvent(ev);
}
function handleStreamEvent(ev) {
  if (ev.type === "user") {
    addUserMessage(ev.text, ev.timestamp);
    state.assistantBody = startAssistant(
      cliLabel((state.conversations.find((c) => c.id === state.viewCid) || {}).cli),
      ev.timestamp,
    );
    refreshTyping();
    scrollDown();
    return;
  }
  if (ev.type === "done") {
    if (state.assistantBody) clearTyping(state.assistantBody);
    state.assistantBody = null;
    updateComposer();
    scrollDown();
    return;
  }
  if (!state.assistantBody) state.assistantBody = startAssistant(cliLabel((state.conversations.find((c) => c.id === state.viewCid) || {}).cli));
  appendEvent(state.assistantBody, ev);
  refreshTyping();
  scrollDown();
}
function sendMessage() {
  const input = $("#input");
  const text = input.value.trim();
  if (!text || !state.viewCid) return;
  wsSend({ type: "message", cid: state.viewCid, text });
  input.value = "";
  input.style.height = "auto";
}

/* ------------------------------------------------------------------ *
 *  Init
 * ------------------------------------------------------------------ */
async function init() {
  setSidebarCollapsed(savedSidebarState(), false);
  await loadConfig();
  await loadModels();
  await loadConversations();
  await loadExternal();
  await restoreConversationFromUrl();
  connectWs();

  $("#sidebar-toggle").onclick = () => setSidebarCollapsed(!state.sidebarCollapsed);
  $("#send-btn").onclick = sendMessage;
  $("#search-btn").onclick = () => setSearchOpen(!state.searchOpen);
  $("#search-submit").onclick = runTranscriptSearch;
  for (const button of document.querySelectorAll("#search-scopes button")) {
    button.onclick = () => {
      setSearchScope(button.dataset.scope);
      if ($("#search-input").value.trim().length >= 2) runTranscriptSearch();
    };
  }
  $("#refresh-btn").onclick = () => { if (state.viewCid) openConversation(state.viewCid); };
  $("#browse-btn").onclick = browseForProject;
  $("#ext-refresh").onclick = loadExternal;
  $("#models-btn").onclick = openModelsModal;
  $("#stats-btn").onclick = openConversationStats;
  $("#modal-close").onclick = closeModal;
  $("#modal").onclick = (e) => { if (e.target.id === "modal") closeModal(); };
  $("#stop-btn").onclick = () => { if (state.viewCid) wsSend({ type: "stop", cid: state.viewCid }); };
  window.addEventListener("popstate", async () => {
    if (sessionKeyFromUrl()) await restoreConversationFromUrl("none");
    else resetView();
  });

  const input = $("#input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  });
  $("#search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runTranscriptSearch(); }
    else if (e.key === "Escape") setSearchOpen(false);
  });
  updateComposer();
}
init();
