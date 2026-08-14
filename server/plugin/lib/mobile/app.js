/* DSH Remote 移动端 — 自研独立 UI（不依赖官方桌面 UI）
   协议：POST /api/<method>，体 {type:"client-request", rpcId, method, payload}
   响应：{type:"server-response", rpcId, result:{ok:true,value} | {ok:false,error}}
   实时性：WebSocket mux 增量为主（16ms 节流重绘），轮询 15s 兜底
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

/* ───────────── 导航（‹ 按钮纯本地出栈，绝不依赖 history；系统返回键走 popstate） ───────────── */
function push(v) {
  state.stack.push(v);
  history.pushState({ view: v }, '');  // 仅用于系统返回键感知
  render();
}
/* 导航模型（WebView 兼容）：
   - push：pushState 新增一层（仅用于系统返回键感知）
   - ‹ 按钮：纯本地出栈 + render + replaceState 对齐 history 栈顶
     （不用 history.back()——WebView 中 back 可能不触发 popstate，
       导致 suppress 标志泄漏、后续返回全部失效）
   - 系统返回键：popstate → 本地出栈 + render；本地栈只有一层时忽略
   history 栈只增不减，系统返回键的多余 popstate 被 length<=1 检查吸收。 */
function goBack() {
  if (state.stack.length <= 1) return;
  state.stack.pop();
  render();
  // 对齐 history 栈顶（防系统返回键多退一层）
  const top = state.stack[state.stack.length - 1];
  try { history.replaceState({ view: top }, ''); } catch {}
}
window.addEventListener('popstate', () => {
  if (state.stack.length > 1) {
    state.stack.pop();
    render();
  }
});
backBtn.addEventListener('click', goBack);

async function render() {
  const cur = state.stack[state.stack.length - 1] || { name: 'workspaces' };
  backBtn.hidden = state.stack.length <= 1;
  moreBtn.hidden = false;
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
        // 预设选择（agentPreset.list 远程可用）
        const r = await rpc('agentPreset.list', {});
        const presets = r.presets || [];
        const def = presets.find((p) => p.isDefault) || presets[0];
        if (presets.length <= 1) {
          // 只有默认预设：直接创建
          const created = await rpc('session.create', { workspaceId: ws.workspaceId, agentPreset: def && def.id });
          push({ name: 'chat', sessionId: created.sessionId, title: '新会话' });
          return;
        }
        // 多个预设：弹层选择
        sheet.innerHTML = '';
        const head = el('div', 'sheet-head', '选择 Agent 预设');
        const close = el('button', 'icon-btn s-close', '✕');
        close.addEventListener('click', closeSheet);
        head.appendChild(close);
        sheet.appendChild(head);
        const body = el('div', 'sheet-body');
        for (const p of presets) {
          const row = el('button', 'list-item');
          row.appendChild(el('div', 'l-icon ws', '🤖'));
          const main = el('div', 'l-main');
          main.appendChild(el('div', 'l-title', p.name + (p.isDefault ? '（默认）' : '')));
          main.appendChild(el('div', 'l-sub', truncate(p.description || '', 60)));
          row.appendChild(main);
          row.addEventListener('click', async () => {
            closeSheet();
            try {
              const created = await rpc('session.create', { workspaceId: ws.workspaceId, agentPreset: p.id });
              push({ name: 'chat', sessionId: created.sessionId, title: '新会话' });
            } catch (e) { toast(e.message); }
          });
          body.appendChild(row);
        }
        sheet.appendChild(body);
        mask.hidden = false;
        sheet.hidden = false;
      } catch (e) { toast('新建失败：' + e.message); }
    });
    view.appendChild(nb);
    // 搜索框：全库会话内容搜索
    const searchBox = el('input', 'rename-input search-input');
    searchBox.type = 'search';
    searchBox.placeholder = '搜索会话内容…';
    searchBox.style.margin = '10px 14px 0';
    searchBox.style.width = 'calc(100% - 28px)';
    view.appendChild(searchBox);
    let searchTimer = null;
    searchBox.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = searchBox.value.trim();
      if (!q) { renderSessions(ws); return; }
      searchTimer = setTimeout(async () => {
        try {
          const r = await rpc('session.search', { query: q });
          const box = view.querySelector('.list');
          if (!box) return;
          box.innerHTML = '';
          if (!r.items || !r.items.length) {
            box.appendChild(el('div', 'note', '没有匹配的会话'));
          }
          for (const hit of r.items) {
            const item = el('button', 'list-item');
            item.appendChild(icon('ses', 'l-icon ses'));
            const main = el('div', 'l-main');
            main.appendChild(el('div', 'l-title', hit.sessionId.slice(0, 20)));
            main.appendChild(el('div', 'l-sub', truncate(hit.snippet || '', 60)));
            item.appendChild(main);
            item.appendChild(el('div', 'l-arrow', '›'));
            item.addEventListener('click', () => push({ name: 'chat', sessionId: hit.sessionId, title: '搜索结果' }));
            box.appendChild(item);
          }
        } catch (e) { /* 搜索失败静默 */ }
      }, 400);
    });
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
      attachLongPress(item, () => showSessionMenu(s, title, () => renderSessions(ws)));
      list.appendChild(item);
    }
    view.appendChild(list);
  } catch (e) {
    view.innerHTML = '';
    view.appendChild(errorCard(e.message, () => renderSessions(ws)));
  }
}

/* ───────────── 复制文本（长按消息） ───────────── */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch (e) {
    toast('复制失败');
  }
}

/* ───────────── 长按 / 会话操作（重命名、归档） ───────────── */
function attachLongPress(el2, onLong) {
  let timer = null;
  let fired = false;
  const start = () => {
    fired = false;
    timer = setTimeout(() => { fired = true; onLong(); }, 500);
  };
  const cancel = () => clearTimeout(timer);
  el2.addEventListener('touchstart', start, { passive: true });
  el2.addEventListener('touchend', cancel);
  el2.addEventListener('touchmove', cancel);
  el2.addEventListener('contextmenu', (e) => { e.preventDefault(); onLong(); });
  el2.addEventListener('click', (e) => { if (fired) { e.stopPropagation(); fired = false; } });
}

function showSessionMenu(s, title, refresh) {
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head', title || '会话操作');
  const close = el('button', 'icon-btn s-close', '✕');
  close.addEventListener('click', closeSheet);
  head.appendChild(close);
  sheet.appendChild(head);
  const body = el('div', 'sheet-body');
  const mk = (label, fn) => {
    const b = el('button', 'sheet-model');
    b.appendChild(el('span', 'm-name', label));
    b.addEventListener('click', () => { closeSheet(); fn(); });
    body.appendChild(b);
  };
  mk('✏️ 重命名', () => renameSession(s, refresh));
  mk('🗂 归档', () => archiveSession(s, refresh));
  sheet.appendChild(body);
  mask.hidden = false;
  sheet.hidden = false;
}

async function renameSession(s, refresh) {
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head', '重命名会话');
  const close = el('button', 'icon-btn s-close', '✕');
  close.addEventListener('click', closeSheet);
  head.appendChild(close);
  sheet.appendChild(head);
  const body = el('div', 'sheet-body');
  const input = el('input', 'rename-input');
  input.type = 'text';
  input.placeholder = '新标题';
  input.value = (s.projections && s.projections.values && s.projections.values.title) || '';
  body.appendChild(input);
  const save = el('button', 'new-btn', '保存');
  save.style.margin = '12px 0 0';
  save.addEventListener('click', async () => {
    const title = input.value.trim();
    if (!title) { toast('标题不能为空'); return; }
    try {
      await rpc('session.rename', { sessionId: s.sessionId, title });
      closeSheet();
      toast('已重命名');
      if (refresh) refresh();
    } catch (e) { toast('重命名失败：' + e.message); }
  });
  body.appendChild(save);
  sheet.appendChild(body);
  mask.hidden = false;
  sheet.hidden = false;
  input.focus();
}

async function archiveSession(s, refresh) {
  // Android WebView 不支持 confirm()，用底部确认面板
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head', '归档会话');
  const close = el('button', 'icon-btn s-close', '✕');
  close.addEventListener('click', closeSheet);
  head.appendChild(close);
  sheet.appendChild(head);
  const body = el('div', 'sheet-body');
  body.appendChild(el('div', 'note', '确定归档「' + ((s.projections && s.projections.values && s.projections.values.title) || s.sessionId.slice(0, 8)) + '」？归档后从列表隐藏，可在电脑端恢复。'));
  const row = el('div', 'dlg-btns');
  const cancel = el('button', 'dlg-btn deny', '取消');
  cancel.addEventListener('click', closeSheet);
  const ok = el('button', 'dlg-btn allow', '归档');
  ok.addEventListener('click', async () => {
    try {
      await rpc('workspace.archiveSession', { sessionId: s.sessionId });
      closeSheet();
      toast('已归档');
      if (refresh) refresh();
    } catch (e) { toast('归档失败：' + e.message); }
  });
  row.appendChild(cancel);
  row.appendChild(ok);
  body.appendChild(row);
  sheet.appendChild(body);
  mask.hidden = false;
  sheet.hidden = false;
}

/* ───────────── 更多菜单（目标/任务/新建工作区） ───────────── */
const moreBtn = $('moreBtn');
const ICONS_MORE = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>';
moreBtn.innerHTML = ICONS_MORE;

function showMoreMenu() {
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head', '更多');
  const close = el('button', 'icon-btn s-close', '✕');
  close.addEventListener('click', closeSheet);
  head.appendChild(close);
  sheet.appendChild(head);
  const body = el('div', 'sheet-body');
  const mk = (label, fn) => {
    const b = el('button', 'sheet-model');
    b.appendChild(el('span', 'm-name', label));
    b.addEventListener('click', () => { closeSheet(); fn(); });
    body.appendChild(b);
  };
  const cur = state.stack[state.stack.length - 1];
  const inChat = cur && cur.name === 'chat';
  mk('🎯 目标', () => showGoalPanel());
  mk('📋 任务', () => showJobsPanel());
  if (inChat) {
    mk('⚡ 命令', () => showCommandsPanel());
    mk('🧩 技能', () => showSkillPanel());
    mk('🔀 子代理', () => showSubagentsPanel());
    mk('📐 计划', () => showPlanPanel());
    mk('⏳ 队列', () => showQueuePanel());
    mk('⬇️ 导出会话', () => exportSession(cur.sessionId));
  }
  mk('📁 文件浏览', () => showFileBrowser());
  mk('🗂 新建工作区', () => createWorkspace());
  mk('🔒 权限说明', () => { toast('权限预设修改被官方远程锁定（403），请在电脑端操作'); });
  sheet.appendChild(body);
  mask.hidden = false;
  sheet.hidden = false;
}
moreBtn.addEventListener('click', showMoreMenu);

/* ───────────── 队列管理（mux session/queue 帧） ───────────── */
let stateQueue = [];
function showQueuePanel() {
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head', '队列');
  const close = el('button', 'icon-btn s-close', '✕');
  close.addEventListener('click', closeSheet);
  head.appendChild(close);
  sheet.appendChild(head);
  const body = el('div', 'sheet-body');
  const cur = state.stack[state.stack.length - 1];
  if (!stateQueue.length) {
    body.appendChild(el('div', 'note', '队列为空'));
  } else {
    for (const item of stateQueue) {
      const text = (item.message && item.message.content || []).map((b) => (b && b.type === 'text' ? b.text : '')).join(' ').slice(0, 60);
      const row = el('div', 'list-item');
      row.appendChild(el('div', 'l-icon ses', item.placement === 'steering' ? '▶' : '·'));
      const main = el('div', 'l-main');
      main.appendChild(el('div', 'l-title', truncate(text || '(非文本消息)', 30)));
      main.appendChild(el('div', 'l-sub', item.placement === 'steering' ? '等待发送' : '上下文'));
      row.appendChild(main);
      const del = el('button', 'chip', '移除');
      del.style.flex = 'none';
      del.addEventListener('click', async () => {
        try {
          await rpc('session.updateQueue', { sessionId: cur.sessionId, itemId: item.id, action: { kind: 'remove' } });
          toast('已移除');
        } catch (e) { toast('操作失败：' + e.message); }
      });
      row.appendChild(del);
      body.appendChild(row);
    }
  }
  sheet.appendChild(body);
  mask.hidden = false;
  sheet.hidden = false;
}

/* ───────────── 会话导出 ───────────── */
function exportSession(sessionId) {
  // 同源下载会携带 Basic Auth；直接触发浏览器下载 JSONL 日志
  location.href = '/api/session.export?sessionId=' + encodeURIComponent(sessionId);
}

/* ───────────── 技能目录（第三批：skill.list，会话上下文） ───────────── */
function showSkillPanel() {
  const cur = state.stack[state.stack.length - 1];
  if (!cur || cur.name !== 'chat') { toast('请在会话中查看技能'); return; }
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head', '技能');
  const close = el('button', 'icon-btn s-close', '✕');
  close.addEventListener('click', closeSheet);
  head.appendChild(close);
  sheet.appendChild(head);
  const body = el('div', 'sheet-body');
  body.appendChild(el('div', 'note', '加载中…'));
  sheet.appendChild(body);
  mask.hidden = false;
  sheet.hidden = false;
  rpc('skill.list', { sessionId: cur.sessionId })
    .then((v) => {
      body.innerHTML = '';
      // 容错解析：items 数组（常见）或 value 直接为数组
      const items = Array.isArray(v) ? v : (v.items || v.skills || []);
      if (!items.length) { body.appendChild(el('div', 'note', '当前会话没有可用技能')); return; }
      for (const s of items) {
        const row = el('div', 'list-item');
        row.appendChild(el('div', 'l-icon ses', '🧩'));
        const main = el('div', 'l-main');
        main.appendChild(el('div', 'l-title', s.name || s.id || '(未命名)'));
        const desc = s.description || s.summary || '';
        main.appendChild(el('div', 'l-sub', truncate(desc, 60)));
        row.appendChild(main);
        body.appendChild(row);
      }
    })
    .catch((e) => { body.innerHTML = ''; body.appendChild(errorCard('技能加载失败：' + e.message)); });
}

/* ───────────── 命令面板（/ 命令：plan/compact/resume/model 等） ─────────────
   命令本质是发「/」开头的消息（DSH 命令通道），清单可维护：
   已知命令 /plan /plan off /model；其余按官方文档补充。
   点击即发送；也可在输入框手输任意命令。 */
const COMMANDS = [
  { cmd: '/plan', desc: '进入计划模式（先设计再执行）' },
  { cmd: '/plan off', desc: '退出计划模式' },
  { cmd: '/model', desc: '切换模型' },
  { cmd: '/compact', desc: '压缩会话上下文（节省 token）' },
  { cmd: '/resume', desc: '恢复/继续会话' },
  { cmd: '/clear', desc: '清空会话消息' },
  { cmd: '/help', desc: '查看可用命令' },
];
function showCommandsPanel() {
  const cur = state.stack[state.stack.length - 1];
  if (!cur || cur.name !== 'chat') { toast('请在会话中使用命令'); return; }
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head', '命令');
  const close = el('button', 'icon-btn s-close', '✕');
  close.addEventListener('click', closeSheet);
  head.appendChild(close);
  sheet.appendChild(head);
  const body = el('div', 'sheet-body');
  for (const c of COMMANDS) {
    const row = el('button', 'list-item');
    row.appendChild(el('div', 'l-icon ses', '/'));
    const main = el('div', 'l-main');
    main.appendChild(el('div', 'l-title', c.cmd));
    main.appendChild(el('div', 'l-sub', c.desc));
    row.appendChild(main);
    row.addEventListener('click', async () => {
      closeSheet();
      try { await sendText(c.cmd); toast('已发送：' + c.cmd); }
      catch (e) { toast('发送失败：' + e.message); }
    });
    body.appendChild(row);
  }
  body.appendChild(el('div', 'note', '也可以在输入框直接输入 / 开头的命令'));
  sheet.appendChild(body);
  mask.hidden = false;
  sheet.hidden = false;
}

/* ───────────── 计划面板（第三批：plan mode 状态 + /plan 命令） ───────────── */
async function sendText(text) {
  const cur = state.stack[state.stack.length - 1];
  if (!cur || cur.name !== 'chat') throw new Error('不在会话中');
  await rpc('session.prompt', { sessionId: cur.sessionId, mode: 'queue', content: [{ type: 'text', text }] });
  startPolling();
}
let planState = { active: false, pending: false };
function showPlanPanel() {
  const cur = state.stack[state.stack.length - 1];
  if (!cur || cur.name !== 'chat') { toast('请在会话中查看计划'); return; }
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head', '计划模式');
  const close = el('button', 'icon-btn s-close', '✕');
  close.addEventListener('click', closeSheet);
  head.appendChild(close);
  sheet.appendChild(head);
  const body = el('div', 'sheet-body');
  const status = planState.active ? '🟢 已激活' : (planState.pending ? '🟡 待生效' : '⚪ 未激活');
  body.appendChild(el('div', 'note', '状态：' + status));
  body.appendChild(el('div', 'note', '计划模式下模型先探索设计，再通过审批提交完整计划。'));
  const mk = (label, cmd) => {
    const b = el('button', 'sheet-model');
    b.appendChild(el('span', 'm-name', label));
    b.addEventListener('click', async () => {
      closeSheet();
      try {
        await sendText(cmd);
        toast('已发送：' + cmd);
      } catch (e) { toast('发送失败：' + e.message); }
    });
    body.appendChild(b);
  };
  mk('📝 进入计划模式 (/plan)', '/plan');
  mk('📤 提交计划退出 (/plan off)', '/plan off');
  mk('✍️ 带想法进入 (/plan 我的计划…)', '/plan ');
  sheet.appendChild(body);
  mask.hidden = false;
  sheet.hidden = false;
}

/* ───────────── 消息反馈（第三批：messageFeedback.put） ───────────── */
async function sendFeedback(messageId, rating) {
  const cur = state.stack[state.stack.length - 1];
  if (!cur || cur.name !== 'chat') return;
  try {
    await rpc('messageFeedback.put', { sessionId: cur.sessionId, messageId, rating });
    toast(rating === 'positive' ? '已赞 ✓' : '已反馈');
  } catch (e) { toast('反馈失败：' + e.message); }
}

/* ───────────── 子代理管理（第三批：subagent.list / history / interrupt） ───────────── */
function showSubagentsPanel() {
  const cur = state.stack[state.stack.length - 1];
  if (!cur || cur.name !== 'chat') { toast('请在会话中查看子代理'); return; }
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head', '子代理');
  const close = el('button', 'icon-btn s-close', '✕');
  close.addEventListener('click', closeSheet);
  head.appendChild(close);
  sheet.appendChild(head);
  const body = el('div', 'sheet-body');
  body.appendChild(el('div', 'note', '加载中…'));
  sheet.appendChild(body);
  mask.hidden = false;
  sheet.hidden = false;
  rpc('subagent.list', { parentSessionId: cur.sessionId })
    .then((v) => {
      body.innerHTML = '';
      const entries = v.entries || [];
      if (!entries.length) {
        body.appendChild(el('div', 'note', v.parentAvailable === false ? '父会话不可用' : '没有子代理'));
        return;
      }
      for (const sa of entries) {
        const row = el('div', 'list-item');
        row.appendChild(el('div', 'l-icon ses', '🔀'));
        const main = el('div', 'l-main');
        const name = sa.name || sa.title || sa.id || '(未命名)';
        main.appendChild(el('div', 'l-title', name));
        const status = sa.status || (sa.running ? 'running' : 'idle');
        main.appendChild(el('div', 'l-sub', status + (sa.updatedAt ? ' · ' + relTime(sa.updatedAt) : '')));
        row.appendChild(main);
        // 中断按钮（运行中才有意义；容错：有 id 就提供）
        const sid = sa.subagentId || sa.id || sa.sessionId;
        if (sid) {
          const stop = el('button', 'chip', '⏹');
          stop.style.flex = 'none';
          stop.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            try {
              await rpc('subagent.interrupt', { subagentId: sid });
              toast('已中断');
            } catch (e) { toast('中断失败：' + e.message); }
          });
          row.appendChild(stop);
        }
        // 点条目看历史
        if (sid) {
          row.addEventListener('click', () => showSubagentHistory(sid, name));
        }
        body.appendChild(row);
      }
    })
    .catch((e) => { body.innerHTML = ''; body.appendChild(errorCard('子代理加载失败：' + e.message)); });
}

function showSubagentHistory(subagentId, name) {
  const cur = state.stack[state.stack.length - 1];
  if (!cur) return;
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head', '子代理 · ' + truncate(name, 12));
  const close = el('button', 'icon-btn s-close', '✕');
  close.addEventListener('click', closeSheet);
  head.appendChild(close);
  sheet.appendChild(head);
  const body = el('div', 'sheet-body');
  body.appendChild(el('div', 'note', '加载中…'));
  sheet.appendChild(body);
  rpc('subagent.history', { subagentId })
    .then((v) => {
      body.innerHTML = '';
      // 容错：events 或 messages 数组
      const events = v.events || v.messages || (Array.isArray(v) ? v : []);
      if (!events.length) { body.appendChild(el('div', 'note', '无历史记录')); return; }
      for (const e of events.slice(-40)) {
        const ev = e.event || e;
        const d = ev.data || {};
        const msg = ev.message || d.message || d;
        const blocks = (msg.content || []).map((b) => (b && b.type === 'text' ? b.text : '')).join(' ');
        const text = blocks || msg.text || ev.type || '';
        if (text) {
          const row = el('div', 'list-item');
          row.appendChild(el('div', 'l-icon ' + (msg.role === 'user' ? 'ws' : 'ses'), msg.role === 'user' ? '你' : '🤖'));
          const main = el('div', 'l-main');
          main.appendChild(el('div', 'l-sub', truncate(text, 120)));
          row.appendChild(main);
          body.appendChild(row);
        }
      }
    })
    .catch((e) => { body.innerHTML = ''; body.appendChild(errorCard('历史加载失败：' + e.message)); });
}

/* ───────────── 文件浏览（host.listDirectory，browse 能力） ───────────── */
let browsePath = null;
let fileBrowserOnPick = null;  // picker 模式回调（null = 纯浏览）
async function showFileBrowser(startPath, onPick) {
  fileBrowserOnPick = onPick || null;
  if (!startPath) {
    // 从当前工作区路径开始
    const wsEntry = [...state.stack].reverse().find((x) => x.ws && x.ws.path);
    startPath = wsEntry ? wsEntry.ws.path : null;
  }
  browsePath = startPath || 'C:\\';
  await renderFileBrowser();
}
async function renderFileBrowser() {
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head', '文件浏览');
  const close = el('button', 'icon-btn s-close', '✕');
  close.addEventListener('click', closeSheet);
  head.appendChild(close);
  sheet.appendChild(head);
  const body = el('div', 'sheet-body');
  body.appendChild(el('div', 'spinner'));
  sheet.appendChild(body);
  mask.hidden = false;
  sheet.hidden = false;
  try {
    const r = await rpc('host.listDirectory', { path: browsePath });
    body.innerHTML = '';
    const crumbs = el('div', 'info-bar');
    crumbs.textContent = browsePath;
    body.appendChild(crumbs);
    const list = el('div', 'list');
    const entries = (r.entries || []).filter((e) => e.isDirectory);
    if (!entries.length) list.appendChild(el('div', 'note', '此目录没有子文件夹'));
    for (const e of entries) {
      const item = el('button', 'list-item');
      item.appendChild(icon('ws', 'l-icon ws'));
      const main = el('div', 'l-main');
      main.appendChild(el('div', 'l-title', e.name));
      item.appendChild(main);
      item.appendChild(el('div', 'l-arrow', '›'));
      item.addEventListener('click', async () => {
        browsePath = e.path;
        await renderFileBrowser();
      });
      list.appendChild(item);
    }
    // 返回上级
    const up = el('button', 'chip', '⬆ 上级');
    up.style.margin = '8px 14px';
    up.addEventListener('click', async () => {
      const idx = browsePath.lastIndexOf('\\');
      if (idx > 2) { browsePath = browsePath.slice(0, idx); await renderFileBrowser(); }
    });
    body.appendChild(list);
    body.appendChild(up);
    // picker 模式：选择当前目录（供工作区/会话创建使用）
    if (fileBrowserOnPick) {
      const pick = el('button', 'new-btn', '📌 选择此目录：' + truncate(browsePath, 24));
      pick.style.margin = '8px 14px 0';
      pick.addEventListener('click', () => {
        const cb = fileBrowserOnPick;
        fileBrowserOnPick = null;
        closeSheet();
        cb(browsePath);
      });
      body.appendChild(pick);
    }
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(el('div', 'note', '浏览失败：' + e.message));
  }
}
/* ───────────── 目标面板 ───────────── */
async function showGoalPanel() {
  const cur = state.stack[state.stack.length - 1];
  if (!cur || cur.name !== 'chat') { toast('请先进入一个会话'); return; }
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head', '目标');
  const close = el('button', 'icon-btn s-close', '✕');
  close.addEventListener('click', closeSheet);
  head.appendChild(close);
  sheet.appendChild(head);
  const body = el('div', 'sheet-body');
  body.appendChild(el('div', 'spinner'));
  sheet.appendChild(body);
  mask.hidden = false;
  sheet.hidden = false;
  try {
    const r = await rpc('session.list', {});
    const s = (r.items || []).find((x) => x.sessionId === cur.sessionId);
    const goal = s && s.projections && s.projections.values && s.projections.values.goal;
    body.innerHTML = '';
    if (!goal || !goal.goal) {
      body.appendChild(el('div', 'note', '当前会话没有目标'));
      const input = el('input', 'rename-input');
      input.placeholder = '目标描述（objective）';
      body.appendChild(input);
      const mk2 = el('button', 'new-btn', '创建目标');
      mk2.style.margin = '12px 0 0';
      mk2.addEventListener('click', async () => {
        const objective = input.value.trim();
        if (!objective) { toast('请输入目标描述'); return; }
        try {
          await rpc('goal.create', { sessionId: cur.sessionId, objective });
          closeSheet();
          toast('目标已创建');
        } catch (e) { toast('创建失败：' + e.message); }
      });
      body.appendChild(mk2);
    } else {
      const g = goal.goal;
      const card = el('div', 'tool');
      const head2 = el('button', 'tool-head');
      head2.appendChild(el('span', 't-icon', '🎯'));
      head2.appendChild(el('span', 't-name', g.phase === 'complete' ? '已完成' : (g.phase === 'paused' ? '已暂停' : '进行中')));
      head2.appendChild(el('span', 't-chev', '›'));
      head2.addEventListener('click', () => card.classList.toggle('open'));
      const body2 = el('div', 'tool-body');
      body2.appendChild(el('pre', null, g.objective || ''));
      body2.appendChild(el('pre', null, '轮次：' + (goal.roundsStarted ?? 0) + '/' + (g.maxGoalRounds ?? '∞')));
      card.appendChild(head2);
      card.appendChild(body2);
      card.classList.add('open');
      body.appendChild(card);
      const row = el('div', 'dlg-btns');
      const mk3 = (label, method, payload) => {
        const b = el('button', 'dlg-btn deny', label);
        b.addEventListener('click', async () => {
          try {
            await rpc(method, { sessionId: cur.sessionId, ref: g.id, ...payload });
            closeSheet();
            toast(label + '成功');
          } catch (e) { toast(label + '失败：' + e.message); }
        });
        return b;
      };
      if (g.phase === 'active' || g.phase === 'running') {
        row.appendChild(mk3('暂停', 'goal.pause'));
        row.appendChild(mk3('完成', 'goal.complete'));
      } else if (g.phase === 'paused') {
        row.appendChild(mk3('继续', 'goal.resume'));
      } else if (g.phase === 'complete') {
        row.appendChild(mk3('清除', 'goal.clear'));
      }
      body.appendChild(row);
    }
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(el('div', 'note', '加载失败：' + e.message));
  }
}

/* ───────────── 任务面板（来自 mux session/jobs 帧） ───────────── */
let stateJobs = [];
function showJobsPanel() {
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head', '任务');
  const close = el('button', 'icon-btn s-close', '✕');
  close.addEventListener('click', closeSheet);
  head.appendChild(close);
  sheet.appendChild(head);
  const body = el('div', 'sheet-body');
  if (!stateJobs.length) {
    body.appendChild(el('div', 'note', '暂无任务（打开会话后实时更新）'));
  } else {
    for (const j of stateJobs) {
      const item = el('div', 'list-item');
      item.appendChild(el('div', 'l-icon ses', j.status === 'running' ? '▶' : '✓'));
      const main = el('div', 'l-main');
      main.appendChild(el('div', 'l-title', j.label || j.kind || j.id));
      main.appendChild(el('div', 'l-sub', (j.status || '') + (j.detail ? ' · ' + j.detail : '')));
      item.appendChild(main);
      body.appendChild(item);
    }
  }
  sheet.appendChild(body);
  mask.hidden = false;
  sheet.hidden = false;
}

/* ───────────── 新建工作区 ───────────── */
function createWorkspace() {
  sheet.innerHTML = '';
  const head = el('div', 'sheet-head', '新建工作区');
  const close = el('button', 'icon-btn s-close', '✕');
  close.addEventListener('click', closeSheet);
  head.appendChild(close);
  sheet.appendChild(head);
  const body = el('div', 'sheet-body');
  const input = el('input', 'rename-input');
  input.placeholder = '文件夹路径，如 C:\\projects\\myapp';
  body.appendChild(input);
  // 浏览选择：打开文件浏览器选目录，填入路径（不必手打地址）
  const browse = el('button', 'chip', '📂 浏览选择');
  browse.style.margin = '8px 0 0';
  browse.addEventListener('click', () => {
    showFileBrowser(null, (path) => { input.value = path; input.focus(); });
  });
  body.appendChild(browse);
  const save = el('button', 'new-btn', '创建');
  save.style.margin = '12px 0 0';
  save.addEventListener('click', async () => {
    const path = input.value.trim();
    if (!path) { toast('请输入路径'); return; }
    try {
      await rpc('workspace.create', { path });
      closeSheet();
      toast('工作区已创建');
      render();
    } catch (e) { toast('创建失败：' + e.message); }
  });
  body.appendChild(save);
  sheet.appendChild(body);
  mask.hidden = false;
  sheet.hidden = false;
  input.focus();
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
      const msgId = (d.message && d.message.id) || d.id;
      for (const b of blocksOf(d.message || d)) {
        const it = blockItem(b);
        if (it) { it.msgId = msgId; items.push(it); }
      }
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
      const toolArgs = d.args ?? d;
      // 交付物：从工具参数提取产出文件路径（edit/write 类工具的 file_path）
      let filePath = null;
      if (typeof toolArgs === 'string') {
        try {
          const parsed = JSON.parse(toolArgs);
          if (parsed && typeof parsed.file_path === 'string') filePath = parsed.file_path;
        } catch { /* 非 JSON 参数忽略 */ }
      } else if (toolArgs && typeof toolArgs.file_path === 'string') {
        filePath = toolArgs.file_path;
      }
      items.push({ kind: 'tool', name: d.toolName || d.name || '工具', args: toolArgs, filePath });
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
  const copyable = (node, text) => attachLongPress(node, () => copyText(text));
  if (it.kind === 'user') {
    const b = el('div', 'bubble user', it.text);
    copyable(b, it.text);
    container.appendChild(b);
  } else if (it.kind === 'ai') {
    const b = el('div', 'bubble ai' + (it.partial ? ' typing' : ''));
    renderMarkdownish(b, it.text);
    copyable(b, it.text);
    container.appendChild(b);
    // 消息反馈（第三批）：👍/👎 → messageFeedback.put
    if (it.msgId && !it.partial) {
      const row = el('div', 'fb-row');
      const up = el('button', 'chip fb-btn', '👍');
      const down = el('button', 'chip fb-btn', '👎');
      up.addEventListener('click', () => sendFeedback(it.msgId, 'positive'));
      down.addEventListener('click', () => sendFeedback(it.msgId, 'negative'));
      row.appendChild(up); row.appendChild(down);
      container.appendChild(row);
    }
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
    // 交付物：产出文件路径（成功时高亮显示）
    if (it.filePath) {
      const file = el('div', 'tool-file' + (it.result !== null && it.result !== undefined ? ' ok' : ''));
      file.appendChild(el('span', null, '📄 ' + it.filePath));
      body.appendChild(file);
    }
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
    await loadSessionInfo(sessionId);
    view.scrollTop = view.scrollHeight;
    startPolling(sessionId);
  } catch (e) {
    view.innerHTML = '';
    view.appendChild(errorCard(e.message, () => renderChat(sessionId)));
  }
}

/* 会话信息条：上下文压力 / token 用量（来自 session.list projections） */
async function loadSessionInfo(sessionId) {
  try {
    const r = await rpc('session.list', {});
    const s = (r.items || []).find((x) => x.sessionId === sessionId);
    if (!s || !s.projections || !s.projections.values) return;
    const v = s.projections.values;
    const cp = v.contextPressure;
    const tu = v.tokenUsage;
    const parts = [];
    if (cp && typeof cp.pressureTokens === 'number' && cp.contextWindow) {
      parts.push('上下文 ' + Math.round(cp.pressureTokens / cp.contextWindow * 100) + '%');
    }
    if (tu) {
      if (tu.outputTokens) parts.push('输出 ' + Math.round(tu.outputTokens / 1000) + 'k');
      if (tu.uncachedInputTokens) parts.push('输入 ' + Math.round(tu.uncachedInputTokens / 1000) + 'k');
    }
    if (!parts.length) return;
    let bar = view.querySelector('.info-bar');
    if (!bar) {
      bar = el('div', 'info-bar');
      view.insertBefore(bar, view.firstChild);
    }
    bar.textContent = parts.join(' · ');
  } catch (e) { /* 信息条失败静默 */ }
}
/* paintChat 节流合并：流式 delta 密集时（WS 每帧一次事件），
   把多次重绘合并为 16ms 一帧，避免大消息全量重建 DOM 卡顿。
   用 setTimeout 而非 rAF（后台 tab 时 rAF 不触发，数据会滞留）。 */
let paintPending = false;
function paintChat(events) {
  state.chatEvents = events;
  if (paintPending) return;
  paintPending = true;
  setTimeout(() => {
    paintPending = false;
    doPaintChat(state.chatEvents || []);
  }, 16);
}
function doPaintChat(events) {
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
mask.addEventListener('touchend', closeSheet);

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
      // 计划模式状态（plan/mode 事件）
      if (ev.type === 'plan/mode') {
        planState = { active: !!d.active, pending: false };
        if (planState.active) toast('📐 计划模式已激活');
      }
      paintChat(state.chatEvents);
      if (state.running) view.scrollTop = view.scrollHeight;
      renderChips();
    }
  } else if (frame.method === 'session/jobs') {
    stateJobs = p.jobs || [];
  } else if (frame.method === 'session/queue') {
    stateQueue = p.items || [];
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
  if (!document.hidden && state.stack.length) render();
});
connectMux();
// 根层必须入栈：主界面不是「兜底渲染」，否则第一层导航没有返回按钮
//（修复：栈为空时点工作区 → 栈深=1 → backHidden=true → 返回键消失）
push({ name: 'workspaces' });
