/* DSH Remote 移动端 — 自研独立 UI（不依赖官方桌面 UI）
   协议：POST /api/<method>，体 {type:"client-request", rpcId, method, payload}
   响应：{type:"server-response", rpcId, result:{ok:true,value} | {ok:false,error}}
   实时性：轮询 session.history（运行中 2s / 空闲 4s），支持流式增量渲染
   事件块字段：线上格式用 type（reasoning/text/tool-call/tool-result），兼容 kind */
'use strict';

/* ───────────── RPC ───────────── */
/* 非安全上下文（如局域网纯 HTTP 直连）下 crypto.randomUUID 不可用，回退到自产 v4 */
function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
async function rpc(method, payload = {}) {
  const rpcId = uuid();
  let res;
  try {
    res = await fetch('/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    });
  } catch (e) { throw new Error('网络错误：' + e.message); }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  let msg;
  try { msg = await res.json(); } catch { throw new Error('响应解析失败'); }
  if (!msg || msg.type !== 'server-response') throw new Error('非法响应');
  const r = msg.result;
  if (!r || r.ok !== true) throw new Error((r.error && r.error.message) || '请求失败');
  return r.value;
}

/* ───────────── 状态 ───────────── */
const state = {
  theme: localStorage.getItem('dsh-m-theme') ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  stack: [],            // [{name:'workspaces'} | {name:'sessions',ws} | {name:'chat',sessionId,title}]
  lastSeq: -1,
  running: false,
  models: null,
  current: null,
  pollTimer: null,
  sending: false,
  chatEvents: null,   // 当前聊天会话事件累计（WS 增量 + 初始历史）
};

const $ = (id) => document.getElementById(id);
const view = $('view'), titleEl = $('title'), backBtn = $('backBtn'),
  composer = $('composer'), input = $('input'), sendBtn = $('sendBtn'),
  chips = $('chips'), sheet = $('sheet'), mask = $('mask');

/* ───────────── 工具函数 ───────────── */
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
/* ── SVG 图标（stroke 线性风格，随 currentColor 变色） ── */
const ICONS = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  theme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4L19 19M19 5l-1.6 1.6M6.6 17.4L5 19"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  ws: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  ses: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.9A8 8 0 1 1 21 12z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  think: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.6L18 9.5l-4.2 1.9L12 16l-1.8-4.6L6 9.5l4.2-1.9z"/><path d="M18.5 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/></svg>',
  tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7l7 5-7 5M11 17h8"/></svg>',
  approval: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none"/></svg>',
  question: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.3 9.2a2.8 2.8 0 1 1 4.4 2.3c-.9.7-1.7 1.2-1.7 2.5"/><circle cx="12" cy="17.4" r="1.2" fill="currentColor" stroke="none"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3c-1.9 0-3.6-.6-5-1.6L3 20l1.8-4.5a8.3 8.3 0 1 1 16.2-4z"/></svg>',
};
function icon(name, cls) {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.innerHTML = ICONS[name] || '';
  return s;
}
function relTime(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}
function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
function fmtJson(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 1); } catch { return String(v); }
}
const blockType = (b) => (b && (b.kind || b.type)) || '';
const blockText = (b) => (b && typeof b.text === 'string') ? b.text : '';
const blocksOf = (d) => (d && ((d.message && d.message.content) || d.content)) || [];
const toolNameOf = (b) => (b && b.payload && b.payload.toolName) || (b && b.toolName) || (b && b.name) || '工具';
const toolArgsOf = (b) => (b && b.payload && b.payload.args) ?? (b && b.args) ?? null;
const toolResultOf = (b) => (b && b.payload && (b.payload.result ?? b.payload.output)) ?? (b && b.result) ?? (b && b.output) ?? null;
const turnKey = (d) => ((d && d.turn) ?? 0) + ':' + ((d && d.step) ?? 0);

/* ───────────── 主题 ───────────── */
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = state.theme === 'dark' ? '#131316' : '#f7f8fa';
}
$('themeBtn').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('dsh-m-theme', state.theme);
  applyTheme();
});

/* ───────────── 导航 ───────────── */
function push(v) { state.stack.push(v); render(); }
function goBack() {
  if (state.stack.length > 1) { state.stack.pop(); render(); }
}
backBtn.addEventListener('click', goBack);

async function render() {
  const cur = state.stack[state.stack.length - 1] || { name: 'workspaces' };
  backBtn.hidden = state.stack.length <= 1;
  stopPolling();
  if (cur.name !== 'chat') state.chatEvents = null;
  composer.hidden = true;
  view.classList.remove('has-composer');
  if (cur.name === 'workspaces') { titleEl.textContent = 'DSH Remote'; await renderWorkspaces(); }
  else if (cur.name === 'sessions') { titleEl.textContent = cur.ws.title || '工作区'; await renderSessions(cur.ws); }
  else if (cur.name === 'chat') { titleEl.textContent = cur.title || '会话'; await renderChat(cur.sessionId); }
}

/* ───────────── 工作区 ───────────── */
async function renderWorkspaces() {
  view.innerHTML = '';
  view.appendChild(el('div', 'spinner'));
  try {
    const ws = await rpc('workspace.list');
    view.innerHTML = '';
    const list = el('div', 'list');
    const items = ws.items || [];
    if (!items.length) {
      const empty = el('div', 'empty-state');
      empty.appendChild(icon('empty'));
      empty.appendChild(el('div', 'e-title', '暂无工作区'));
      empty.appendChild(el('div', 'e-sub', '在电脑端创建或打开一个工作区后，这里会显示'));
      list.appendChild(empty);
    } else {
      for (const w of items) {
        const item = el('button', 'list-item');
        item.appendChild(icon('ws', 'l-icon ws'));
        const main = el('div', 'l-main');
        main.appendChild(el('div', 'l-title', w.title || w.path));
        main.appendChild(el('div', 'l-sub', w.path));
        item.appendChild(main);
        item.appendChild(el('div', 'l-arrow', '›'));
        item.addEventListener('click', () => push({ name: 'sessions', ws: w }));
        list.appendChild(item);
      }
    }
    view.appendChild(list);
    const link = el('a', 'footer-link', '需要完整桌面功能？打开桌面版 ›');
    link.href = '/';
    view.appendChild(link);
  } catch (e) {
    view.innerHTML = '';
    view.appendChild(errorCard(e.message, renderWorkspaces));
  }
}

/* ───────────── 会话列表 ───────────── */
async function renderSessions(ws) {
  view.innerHTML = '';
  view.appendChild(el('div', 'spinner'));
  try {
    const sess = await rpc('session.list', {});
    view.innerHTML = '';
    const nb = el('button', 'new-btn');
    nb.appendChild(icon('plus'));
    nb.appendChild(el('span', null, '新建会话'));
    nb.addEventListener('click', async () => {
      try {
        const created = await rpc('session.create', { workspaceId: ws.workspaceId });
        push({ name: 'chat', sessionId: created.sessionId, title: '新会话' });
      } catch (e) { toast(e.message); }
    });
    view.appendChild(nb);
    const list = el('div', 'list');
    const wsPath = ws.path || '';
    const items = (sess.items || [])
      .filter((s) => s.cwd === wsPath)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (!items.length) {
      const empty = el('div', 'empty-state');
      empty.appendChild(icon('ses'));
      empty.appendChild(el('div', 'e-title', '还没有会话'));
      empty.appendChild(el('div', 'e-sub', '点上方按钮新建一个会话'));
      list.appendChild(empty);
    }
    for (const s of items) {
      const title = (s.projections && s.projections.values && s.projections.values.title) ||
        (s.blank ? '新会话' : '未命名会话');
      const item = el('button', 'list-item');
      item.appendChild(icon('ses', 'l-icon ses'));
      const main = el('div', 'l-main');
      main.appendChild(el('div', 'l-title', title));
      main.appendChild(el('div', 'l-sub', relTime(s.updatedAt) + (s.agentPreset ? ' · ' + s.agentPreset : '')));
      item.appendChild(main);
      if (s.running) item.appendChild(el('span', 'badge-running', '运行中'));
      item.appendChild(el('div', 'l-arrow', '›'));
      item.addEventListener('click', () => push({ name: 'chat', sessionId: s.sessionId, title }));
      list.appendChild(item);
    }
    view.appendChild(list);
  } catch (e) {
    view.innerHTML = '';
    view.appendChild(errorCard(e.message, () => renderSessions(ws)));
  }
}

/* ───────────── 聊天：事件 → 渲染项 ─────────────
   两遍法：先找已完结的 turn（有 assistant/message），其流式 chunk 跳过；
   未完结 turn 的 delta 累积为"活"块（带 ▍ 光标）。 */
function buildChat(events) {
  const finalized = new Set();
  for (const ev of events) if (ev.type === 'assistant/message') finalized.add(turnKey(ev.data || {}));
  const stream = new Map();
  const items = [];
  const liveUpdate = (key, kind, text) => {
    const found = items.find((o) => o.live === key);
    if (found) found.text = text;
    else items.push({ kind, text, live: key, partial: true });
  };
  for (const ev of events) {
    const d = ev.data || {};
    if (ev.type === 'user/message') {
      // 跳过系统注入上下文（plugin/skill-catalog 等），只显示真实用户消息
      if (d.source && d.source.kind && d.source.kind !== 'user') continue;
      for (const b of blocksOf(d)) if (blockType(b) === 'text' && blockText(b)) items.push({ kind: 'user', text: blockText(b) });
    } else if (ev.type === 'assistant/message') {
      for (const b of blocksOf(d.message || d)) items.push(blockItem(b));
    } else if (ev.type === 'assistant/chunk') {
      const c = d.chunk || {};
      const tk = turnKey(d);
      if (finalized.has(tk)) continue; // 最终消息已覆盖流式块
      const key = tk + ':' + (c.index ?? 0);
      if (c.type === 'block-start') {
        stream.set(key, { type: c.blockType, text: '' });
      } else if (c.type === 'reasoning-delta' || c.type === 'text-delta') {
        const s = stream.get(key) || { type: c.type === 'reasoning-delta' ? 'reasoning' : 'text', text: '' };
        s.text += c.text || '';
        stream.set(key, s);
        liveUpdate(key, s.type === 'reasoning' ? 'think' : 'ai', s.text + '▍');
      } else if (c.type === 'block-end' && c.block && typeof c.block === 'object') {
        stream.delete(key);
        items.push(blockItem(c.block));
      }
      // usage / finish / 其它：忽略
    } else if (ev.type === 'tool/call') {
      items.push({ kind: 'tool', name: d.toolName || d.name || '工具', args: d.args ?? d });
    } else if (ev.type === 'tool/result') {
      const last = [...items].reverse().find((o) => o.kind === 'tool' && !o.result);
      if (last) last.result = toolResultOf(d);
      else items.push({ kind: 'tool', name: '工具结果', args: null, result: toolResultOf(d) });
    } else if (ev.type === 'compaction/summary') {
      items.push({ kind: 'note', text: '（会话上下文已压缩整理）' });
    }
  }
  return items;
}
function blockItem(b) {
  if (!b || typeof b !== 'object') return null;
  const t = blockType(b);
  if (t === 'text') return { kind: 'ai', text: blockText(b) };
  if (t === 'reasoning') return { kind: 'think', text: blockText(b) };
  if (t === 'tool-call') return { kind: 'tool', name: toolNameOf(b), args: toolArgsOf(b), result: null };
  if (t === 'tool-result') return { kind: 'tool', name: '工具结果', args: null, result: toolResultOf(b) };
  return null;
}

function renderItem(container, it) {
  if (!it) return;
  if (it.kind === 'user') {
    const b = el('div', 'bubble user', it.text);
    container.appendChild(b);
  } else if (it.kind === 'ai') {
    const b = el('div', 'bubble ai' + (it.partial ? ' typing' : ''));
    renderMarkdownish(b, it.text);
    container.appendChild(b);
  } else if (it.kind === 'think') {
    const t = el('div', 'think');
    const head = el('button', 'think-head');
    head.appendChild(icon('think'));
    head.appendChild(el('span', 't-label', '深度思考'));
    head.appendChild(el('span', 't-chev', '›'));
    const body = el('div', 'think-body', it.text);
    head.addEventListener('click', () => t.classList.toggle('open'));
    t.appendChild(head); t.appendChild(body);
    container.appendChild(t);
  } else if (it.kind === 'tool') {
    const t = el('div', 'tool' + (it.result !== null && it.result !== undefined ? ' ok' : ''));
    const head = el('button', 'tool-head');
    head.appendChild(icon('tool', 't-icon'));
    head.appendChild(el('span', 't-name', truncate(it.name, 30)));
    head.appendChild(el('span', 't-status', it.result !== null && it.result !== undefined ? '完成' : '进行中'));
    head.appendChild(el('span', 't-chev', '›'));
    const body = el('div', 'tool-body');
    if (it.args !== null && it.args !== undefined) body.appendChild(el('pre', null, truncate(fmtJson(it.args), 2000)));
    if (it.result !== null && it.result !== undefined) body.appendChild(el('pre', null, truncate(fmtJson(it.result), 3000)));
    head.addEventListener('click', () => t.classList.toggle('open'));
    t.appendChild(head); t.appendChild(body);
    container.appendChild(t);
  } else if (it.kind === 'note') {
    container.appendChild(el('div', 'note', it.text));
  }
}
/* 轻量格式化：保留换行，``` 围栏转 <pre>，其余纯文本（XSS 安全） */
function renderMarkdownish(container, text) {
  const parts = String(text).split(/```/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      container.appendChild(el('pre', null, parts[i].replace(/^[a-zA-Z0-9_+-]+\n/, '')));
    } else if (parts[i]) {
      container.appendChild(el('div', null, parts[i]));
    }
  }
}

function computeRunning(events) {
  let running = false;
  for (const ev of events) {
    if (ev.type === 'turn/start') running = true;
    else if (ev.type === 'turn/end') running = false;
  }
  return running;
}

async function renderChat(sessionId) {
  view.innerHTML = '';
  view.appendChild(el('div', 'spinner'));
  try {
    // 45 秒超时兜底：隧道带宽低时避免无限转圈
    const h = await Promise.race([
      rpc('session.history', { sessionId, maxMessages: 40 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('加载超时（隧道较慢），请稍后重试')), 45000)),
    ]);
    const events = (h.events || []).map((x) => x.event).filter(Boolean);
    state.chatEvents = events;
    state.lastSeq = events.length ? events[events.length - 1].seq : -1;
    state.running = computeRunning(events);
    paintChat(state.chatEvents);
    composer.hidden = false;
    view.classList.add('has-composer');
    await loadModels(sessionId);
    view.scrollTop = view.scrollHeight;
    startPolling(sessionId);
  } catch (e) {
    view.innerHTML = '';
    view.appendChild(errorCard(e.message, () => renderChat(sessionId)));
  }
}
function paintChat(events) {
  const items = buildChat(events);
  const chat = el('div', 'chat');
  if (!items.length) chat.appendChild(el('div', 'note', '还没有消息，发一句话开始吧'));
  for (const it of items) renderItem(chat, it);
  const old = view.querySelector('.chat');
  if (old) view.replaceChild(chat, old);
  else view.insertBefore(chat, view.querySelector('.generating'));
  const g = view.querySelector('.generating');
  if (state.running) {
    if (!g) {
      const gen = el('div', 'generating');
      gen.appendChild(el('span', null, '生成中'));
      const dots = el('span', 'dots');
      dots.appendChild(el('span'));
      dots.appendChild(el('span'));
      dots.appendChild(el('span'));
      gen.appendChild(dots);
      view.appendChild(gen);
    }
  } else if (g) {
    g.remove();
  }
  if (state.running) view.scrollTop = view.scrollHeight;
}

/* ───────────── 轮询（兜底；增量主要走 WebSocket mux） ───────────── */
function startPolling(sessionId) {
  stopPolling();
  const tick = async () => {
    try {
      const h = await rpc('session.history', { sessionId, maxMessages: 40 });
      const events = (h.events || []).map((x) => x.event).filter(Boolean);
      const last = events.length ? events[events.length - 1].seq : -1;
      const running = computeRunning(events);
      if (last > state.lastSeq || running !== state.running) {
        state.lastSeq = last;
        state.running = running;
        state.chatEvents = events;
        paintChat(state.chatEvents);
      }
    } catch (e) { /* 轮询失败静默，下轮重试 */ }
    state.pollTimer = setTimeout(tick, 15000);
  };
  tick();
}
function stopPolling() {
  if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
}

/* ───────────── 发送 ───────────── */
function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 132) + 'px';
}
input.addEventListener('input', autoGrow);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
sendBtn.addEventListener('click', send);

async function send() {
  const cur = state.stack[state.stack.length - 1];
  if (!cur || cur.name !== 'chat' || state.sending) return;
  const text = input.value.trim();
  if (!text) return;
  state.sending = true;
  sendBtn.disabled = true;
  try {
    await rpc('session.prompt', {
      sessionId: cur.sessionId,
      mode: state.running ? 'steer' : 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    input.value = '';
    autoGrow();
    state.running = true;
    // 发送后刷新一次，后续增量走 WS
    const h = await rpc('session.history', { sessionId: cur.sessionId, maxMessages: 40 });
    const events = (h.events || []).map((x) => x.event).filter(Boolean);
    state.chatEvents = events;
    state.lastSeq = events.length ? events[events.length - 1].seq : -1;
    state.running = computeRunning(events);
    paintChat(state.chatEvents);
    view.scrollTop = view.scrollHeight;
  } catch (e) {
    toast('发送失败：' + e.message);
  }
  state.sending = false;
  sendBtn.disabled = false;
}

/* ───────────── 模型选择 ───────────── */
async function loadModels(sessionId) {
  try {
    const m = await rpc('session.models', { sessionId });
    state.models = m;
    state.current = m.current || null;
  } catch { state.models = null; state.current = null; }
  renderChips();
}
function renderChips() {
  chips.innerHTML = '';
  if (!state.current) return;
  const c = el('button', 'chip');
  c.appendChild(el('span', 'c-m', (state.current.model || '模型') + (state.current.reasoningEffort ? ' · ' + state.current.reasoningEffort : '')));
  c.appendChild(el('span', 'c-a', '▾'));
  c.addEventListener('click', openSheet);
  chips.appendChild(c);
  if (state.running) {
    const stop = el('button', 'chip', '停止生成');
    stop.addEventListener('click', async () => {
      const cur = state.stack[state.stack.length - 1];
      try { await rpc('session.cancel', { sessionId: cur.sessionId }); } catch (e) { toast(e.message); }
    });
    chips.appendChild(stop);
  }
}
function openSheet() {
  if (!state.models) return;
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head', '选择模型');
  const close = el('button', 'icon-btn s-close', '✕');
  close.addEventListener('click', closeSheet);
  head.appendChild(close);
  sheet.appendChild(head);
  const body = el('div', 'sheet-body');
  const groups = state.models.groups || [];
  if (!groups.length) body.appendChild(el('div', 'sheet-empty', '暂无可用模型'));
  for (const g of groups) {
    body.appendChild(el('div', 'sheet-group-name', g.name));
    for (const m of g.models) {
      const sel = state.current && state.current.provider === g.id && state.current.model === m.id;
      const btn = el('button', 'sheet-model' + (sel ? ' sel' : ''));
      btn.appendChild(el('span', 'm-name' + (sel ? ' sel-name' : ''), m.name || m.id));
      btn.appendChild(el('span', 'm-check', sel ? '✓' : ''));
      btn.addEventListener('click', async () => {
        const effort = (m.reasoning && m.reasoning.defaultEffort) ||
          (m.reasoning && m.reasoning.efforts && m.reasoning.efforts[0] && m.reasoning.efforts[0].id);
        try {
          const r = await rpc('session.selectModel', {
            sessionId: state.stack[state.stack.length - 1].sessionId,
            provider: g.id, model: m.id,
            ...(effort ? { reasoningEffort: effort } : {}),
          });
          state.current = r.selected;
          renderChips();
          closeSheet();
        } catch (e) { toast(e.message); }
      });
      body.appendChild(btn);
    }
  }
  sheet.appendChild(body);
  mask.hidden = false;
  sheet.hidden = false;
}
function closeSheet() { sheet.hidden = true; mask.hidden = true; }
mask.addEventListener('click', closeSheet);

/* ───────────── 杂项 ───────────── */
function errorCard(message, retry) {
  const card = el('div', 'error-card');
  card.appendChild(el('div', null, '加载失败'));
  card.appendChild(el('div', null, message));
  if (retry) {
    const btn = el('button', 'retry-btn', '重试');
    btn.addEventListener('click', retry);
    card.appendChild(btn);
  }
  return card;
}
let toastTimer = null;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = el('div', 'toast');
    t.style.cssText = 'position:fixed;left:50%;bottom:120px;transform:translateX(-50%);background:rgba(0,0,0,.78);color:#fff;padding:10px 18px;border-radius:999px;font-size:14px;z-index:200;max-width:82vw;text-align:center';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 2600);
}

/* ───────────── 审批 / 提问（WebSocket mux 实时推送） ─────────────
   宿主在工具需要批准时推送 {method:"approval/requested", rpcId, payload:{sessionId, approvalId, toolName, reason}}
   或提问 {method:"question/requested", rpcId, payload:{sessionId, questions}}；
   客户端经 POST /api/respond 回 client-response 信封应答。mux 连接打开时会重放所有挂起项。 */
let mux = null, muxRetry = null, pendingDlg = null;

/* DSH 的 events.mux 是 WebSocket 通道（GET 直连返回 426 upgrade required）：
   浏览器在握手时自动携带同源的 Basic Auth，经认证代理升级隧道到 DSH。 */
function connectMux() {
  if (mux) return;
  let ws;
  try {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/events.mux');
  } catch { return; }
  mux = ws;
  ws.onmessage = (e) => {
    let frame;
    try { frame = JSON.parse(e.data); } catch { return; }
    handleMux(frame);
  };
  ws.onclose = () => {
    if (mux === ws) mux = null;
    clearTimeout(muxRetry);
    muxRetry = setTimeout(connectMux, 3000);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function handleMux(frame) {
  const p = frame.payload || {};
  if (frame.method === 'approval/requested') {
    showApproval(frame.rpcId, p);
  } else if (frame.method === 'approval/resolved') {
    if (pendingDlg && pendingDlg.kind === 'approval' && pendingDlg.approvalId === p.approvalId) closeDialog();
  } else if (frame.method === 'question/requested') {
    showQuestion(frame.rpcId, p);
  } else if (frame.method === 'question/resolved') {
    if (pendingDlg && pendingDlg.kind === 'question' && pendingDlg.rpcId === p.questionRpcId) closeDialog();
  } else if (frame.method === 'session/event') {
    // 实时增量：当前聊天会话的新事件直接追加渲染，替代频繁全量轮询
    const cur = state.stack[state.stack.length - 1];
    const ev = p.event;
    if (cur && cur.name === 'chat' && p.sessionId === cur.sessionId && ev && ev.seq > state.lastSeq) {
      if (!state.chatEvents) state.chatEvents = [];
      state.chatEvents.push(ev);
      state.lastSeq = ev.seq;
      if (ev.type === 'turn/start') state.running = true;
      else if (ev.type === 'turn/end') state.running = false;
      paintChat(state.chatEvents);
      if (state.running) view.scrollTop = view.scrollHeight;
      renderChips();
    }
  }
}

async function respond(frame, value) {
  try {
    const res = await fetch('/api/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId: frame.rpcId, result: { ok: true, value } }),
    });
    const msg = await res.json().catch(() => null);
    if (msg && msg.accepted === false) toast('应答未受理：' + (msg.reason || '未知'));
  } catch (e) { toast('应答失败：' + e.message); }
}

function openDialog(content) {
  const dlg = $('dialog');
  dlg.innerHTML = '';
  dlg.appendChild(content);
  dlg.hidden = false;
}
function closeDialog() {
  const dlg = $('dialog');
  dlg.hidden = true;
  dlg.innerHTML = '';
  pendingDlg = null;
}

function showApproval(rpcId, p) {
  const d = el('div', 'dlg');
  const ic = el('div', 'dlg-icon approval');
  ic.appendChild(icon('approval'));
  d.appendChild(ic);
  d.appendChild(el('div', 'dlg-title', '权限请求'));
  d.appendChild(el('div', 'dlg-tool', '工具：' + (p.toolName || '未知')));
  if (p.reason) d.appendChild(el('div', 'dlg-reason', p.reason));
  d.appendChild(el('div', 'dlg-sub', '会话：' + truncate(p.sessionId || '', 26)));
  const btns = el('div', 'dlg-btns');
  const deny = el('button', 'dlg-btn deny', '拒绝');
  deny.addEventListener('click', async () => {
    await respond({ rpcId }, { sessionId: p.sessionId, approvalId: p.approvalId, outcome: 'rejected' });
    closeDialog();
  });
  const allow = el('button', 'dlg-btn allow', '允许一次');
  allow.addEventListener('click', async () => {
    await respond({ rpcId }, { sessionId: p.sessionId, approvalId: p.approvalId, outcome: 'allowed-once' });
    closeDialog();
  });
  btns.appendChild(deny); btns.appendChild(allow);
  d.appendChild(btns);
  pendingDlg = { kind: 'approval', rpcId, sessionId: p.sessionId, approvalId: p.approvalId };
  openDialog(d);
}

function showQuestion(rpcId, p) {
  const d = el('div', 'dlg');
  const ic = el('div', 'dlg-icon question');
  ic.appendChild(icon('question'));
  d.appendChild(ic);
  d.appendChild(el('div', 'dlg-title', '需要你回答'));
  const answers = [];
  for (const q of (p.questions || [])) {
    const box = el('div', 'q-box');
    box.appendChild(el('div', 'q-text', q.question || q.header || '问题'));
    if (q.detail) box.appendChild(el('div', 'q-detail', q.detail));
    const selected = [];
    const opts = el('div', 'q-opts');
    for (const o of (q.options || [])) {
      const b = el('button', 'q-opt', o.label);
      b.addEventListener('click', () => {
        if (q.multiSelect) {
          const i = selected.indexOf(o.label);
          if (i >= 0) { selected.splice(i, 1); b.classList.remove('sel'); }
          else { selected.push(o.label); b.classList.add('sel'); }
        } else {
          selected.length = 0; selected.push(o.label);
          opts.querySelectorAll('.q-opt').forEach((x) => x.classList.remove('sel'));
          b.classList.add('sel');
        }
      });
      opts.appendChild(b);
    }
    box.appendChild(opts);
    answers.push({ id: q.id, selected });
    d.appendChild(box);
  }
  const btns = el('div', 'dlg-btns');
  const submit = el('button', 'dlg-btn allow', '提交');
  submit.addEventListener('click', async () => {
    const final = answers.map((a) => ({ id: a.id, selected: [...a.selected] }));
    if (final.some((a) => a.selected.length === 0)) { toast('还有问题未选择'); return; }
    await respond({ rpcId }, { sessionId: p.sessionId, answer: { answers: final } });
    closeDialog();
  });
  btns.appendChild(submit);
  d.appendChild(btns);
  pendingDlg = { kind: 'question', rpcId, sessionId: p.sessionId };
  openDialog(d);
}

/* ───────────── 启动 ───────────── */
applyTheme();
backBtn.innerHTML = ICONS.back;
themeBtn.innerHTML = ICONS.theme;
sendBtn.innerHTML = ICONS.send;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) render();
});
connectMux();
render();
