#!/usr/bin/env node
/*
 * local-statusline.js — Claude Code 底部状态栏。
 *
 * 显示内容：
 *   模型 │ 目录 ⎇ git 分支 │ kw:主代理本轮:会话累计 │ ▸ SubAgent:运行:总数 │ 上下文占用 │ ▸ 当前虚拟机 5h │ 7d
 *   各模块连成一串，按 Claude Code 传入的 COLUMNS 只在模块之间换行；额度的 5h 与 7d 属于同一模块。
 *   额度展开：当前与其余虚拟机另起一张按列对齐的表；SubAgent 展开：未在运行的子代理及其保活状态。
 *
 * 额度来自 vm2api 网页面板接口，显示已用比例、窗口记录金额/预计容量和距重置时间。
 * 预计容量按已记录美元金额除以当前已用比例估算，以 ≈ 标记；不是官方订阅扣费。
 * 站点与槽位由相邻 local-statusline-quota-config.json 配置，登录信息复用既有私密文件。
 *
 * 自定义状态栏按 statusLine.refreshInterval 刷新；运行中的子代理显示在 Claude 原生面板，由 Claude Code 刷新。
 * 额度约每 30 秒更新；渲染立即退出，独立后台刷新完成后由下一次重绘显示。
 * 已到重置时间的窗口显示 0%；真正未知或超过 10 分钟的缓存显示 --。
 *
 * 配置（~/.claude/settings.json）：
 *   "statusLine": { "type": "command", "command": "node /绝对路径/local-statusline.js" }
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readConfig, readJson, writePrivateJson, queryQuota } = require('./vm2api-quota');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CACHE = path.join(CLAUDE_DIR, 'cache', 'local-statusline-quota.json');
const SESSION = path.join(CLAUDE_DIR, 'cache', 'local-statusline-vm2api-session.json');
const LOCK = CACHE + '.lock';
const TIMEOUT_MS = 15_000;                   // 整轮登录与读取共享超时
const TAIL_BYTES = 512 * 1024;               // 回退计算上下文时只读会话记录末尾
const SEP = ' \x1b[2m│\x1b[0m ';

function readStdin() { try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return {}; } }
function safe(fn) { try { return fn(); } catch (_) { return null; } }

function readCache() {
  const cached = readJson(CACHE);
  return cached?._source === safe(() => readConfig(CLAUDE_DIR).source) ? cached : null;
}
function writeCache(obj) {
  // 原子替换，避免并发读取半个文件；缓存及登录会话均仅本用户可读。
  writePrivateJson(CACHE, obj);
}

function acquireRefreshLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  try {
    if (Date.now() - fs.statSync(LOCK).mtimeMs > TIMEOUT_MS * 2) fs.unlinkSync(LOCK);
  } catch (_) {}
  try {
    const fd = fs.openSync(LOCK, 'wx', 0o600);
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

// 单账户旧缓存的强制刷新，供未安装双账户脚本时的保活插件调用；失败时保留旧数据
async function refresh() {
  if (!acquireRefreshLock()) return;
  try {
    const config = readConfig(CLAUDE_DIR);
    const cached = readCache() || {};
    const now = Date.now();
    const attempted = { ...cached, _source: config.source, _tried: now };
    writeCache(attempted);
    try {
      const data = await queryQuota({ config, sessionFile: SESSION, signal: AbortSignal.timeout(TIMEOUT_MS) });
      writeCache({ _source: config.source, _ts: Date.now(), _tried: now, data });
    } catch (error) {
      // 仅记录本地定义的错误码，接口正文和登录凭据不进入日志。
      const code = /^quota_[a-z0-9_]+$/.test(error.message) ? error.message : 'quota_refresh_failed';
      writeCache({ ...attempted, _error: code });
      throw new Error(code);
    }
  } finally {
    if (safe(() => fs.readFileSync(LOCK, 'utf8')) === String(process.pid)) {
      try { fs.unlinkSync(LOCK); } catch (_) {}
    }
  }
}

function inputTokens(u) {
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

// 从会话记录末尾找最近一次主对话请求的输入量，即当前上下文大小
function lastContextFromTranscript(file) {
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, size - len);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    const o = safe(() => JSON.parse(lines[i]));
    const m = o && o.type === 'assistant' && !o.isSidechain && o.message;
    if (m && m.usage && m.model !== '<synthetic>') return inputTokens(m.usage);
  }
  return null;
}

function contextUsage(sess) {
  const cw = sess.context_window || {};
  const modelId = (sess.model && sess.model.id) || '';
  const size = cw.context_window_size || (/\[1m\]/i.test(modelId) ? 1_000_000 : 200_000);
  let used = cw.current_usage ? inputTokens(cw.current_usage) : null;
  if (used == null && sess.transcript_path) used = safe(() => lastContextFromTranscript(sess.transcript_path));
  if (used == null) return null;
  return { used, size, pct: Math.min(100, (used / size) * 100) };
}

function gitBranch(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const dotgit = path.join(d, '.git');
    try {
      let gitdir = dotgit;
      if (fs.statSync(dotgit).isFile()) {          // worktree 或子模块：.git 是指向真实目录的文件
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'));
        if (m) gitdir = path.resolve(d, m[1].trim());
      }
      const head = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      return ref ? ref[1] : head.slice(0, 7);
    } catch (_) {}
    if (path.dirname(d) === d) return '';
  }
}

function fmtNum(n) {
  n = Number(n) || 0;
  const short = (v, unit) => v.toFixed(v >= 10 ? 0 : 1).replace(/\.0$/, '') + unit;
  if (n >= 1e9) return short(n / 1e9, 'B');
  if (n >= 1e6) return short(n / 1e6, 'M');
  if (n >= 1e3) return short(n / 1e3, 'k');
  return String(n);
}
function fmtCost(n) {
  return '$' + n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2);
}
function fmtReset(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) return 'now';
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return d + 'd' + (h % 24) + 'h';
  if (h >= 1) return h + 'h' + (m % 60) + 'm';
  return m + 'm';
}
function bar(pct) {
  const n = Math.max(0, Math.min(10, Math.round((Number(pct) || 0) / 10)));
  return '█'.repeat(n) + '░'.repeat(10 - n);
}
// 已用比例 + 进度条，按占用程度着色；表格里百分比右对齐到固定宽度
function meter(pct, digits = 0, pad = 0) {
  const color = pct < 50 ? '\x1b[32m' : pct < 80 ? '\x1b[33m' : '\x1b[31m';
  return `${color}${(pct.toFixed(digits) + '%').padStart(pad)} ${bar(pct)}\x1b[0m`;
}
function ctxStr(c) {
  return `ctx ${meter(c.pct, c.pct < 10 ? 1 : 0)} ${fmtNum(c.used)}/${fmtNum(c.size)}`;
}
// 额度窗口拆成已用比例、金额、重置时间；数据未知时返回 null。
function windowParts(w) {
  // 旧缓存也在重置时立即归零，不等待服务端建立下一窗口。
  if (w?.reset_at && Date.parse(w.reset_at) <= Date.now()) return { pct: 0, cost: '', reset: '' };
  if (!w || w.stale || w.used_percent == null) return null;
  if (!w.reset_at && w.used_percent !== 0) return null;
  let cost = '';
  if (w.used_cost != null) {
    cost = fmtCost(w.used_cost);
    if (w.estimated_total_cost != null) cost += '/≈' + fmtCost(w.estimated_total_cost);
    else {
      const reason = { low_usage: '低用量' }[w.estimate_status];
      if (reason) cost += `（${reason}）`;
    }
  }
  return { pct: w.used_percent, cost, reset: fmtReset(w.reset_at) };
}
function windowStr(label, w) {
  const p = windowParts(w);
  if (!p) return `${label} --`;
  return `${label} ${meter(p.pct)}` + (p.cost ? ' ' + p.cost : '') + (p.reset ? ' ' + p.reset : '');
}

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const knownCount = value => Number.isSafeInteger(value) && value >= 0;
const formatCount = value => knownCount(value) ? value : '-';
const serverCount = value => knownCount(value) ? value : 0;
// 当前在前、总数在后：kw:本轮:累计，与 SubAgent:运行:总数 一致。
const formatKeepwarm = (total, round) => `kw:${formatCount(round)}:${formatCount(total)}`;
const dim = text => `\x1b[2m${text}\x1b[0m`;

function readKeepwarm(id) {
  if (!validId(id)) return null;
  const state = readJson(path.join(CLAUDE_DIR, 'keepwarm', 'sessions', `${id}.json`));
  return state?.sessionId && state.sessionId !== id ? null : state;
}

function keepwarmDisabled() {
  const settings = readJson(path.join(CLAUDE_DIR, 'settings.json'));
  return settings?.enabledPlugins?.['keepwarm@keepwarm'] === false ||
    fs.existsSync(path.join(os.homedir(), '.claude', 'keepwarm-off'));
}

// 保留插件状态指示，并从主代理自己的分项读取本轮次数。
function keepwarmStr(sess, state = readKeepwarm(sess.session_id), off = keepwarmDisabled()) {
  let round = state?.mainRoundBumps;
  if (round === undefined && state?.version === 4 && knownCount(state.roundBumps) && Array.isArray(state.targets)) {
    round = state.targets.find(target => target?.id === 'main')?.roundBumps;
  }
  // 代理做的服务端保活按对话另记在 targets 里（插件重载时只恢复本地次数），显示时合并：
  // 累计加上全部对话的服务端次数，本轮只加主对话的。
  const targets = Array.isArray(state?.targets) ? state.targets : [];
  const serverTotal = targets.reduce((sum, target) => sum + serverCount(target?.serverKeepaliveTotal), 0);
  const total = knownCount(state?.bumps) ? state.bumps + serverTotal : state?.bumps;
  if (knownCount(round)) round += serverCount(targets.find(target => target?.id === 'main')?.serverKeepaliveCount);
  const counts = formatKeepwarm(total, round);
  if (!off && !['active', 'paused', 'stopped'].includes(state?.state)) return dim(counts);
  const stopped = off || state?.state === 'stopped';
  const paused = state?.state === 'paused';
  const color = stopped ? '\x1b[2m' : paused || state?.cold ? '\x1b[33m' : '\x1b[32m';
  return `${color}${stopped || paused ? '○' : '●'}\x1b[0m ${counts}`;
}

function keepwarmAgents(state) {
  const targets = new Map();
  const agents = new Map();
  if (Array.isArray(state?.agentViews)) for (const agent of state.agentViews) {
    if (validId(agent?.id) && agent.id !== 'main') agents.set(agent.id, agent);
  }
  if (Array.isArray(state?.targets)) for (const target of state.targets) {
    if (!validId(target?.id) || target.id === 'main') continue;
    targets.set(target.id, target);
    if (!agents.has(target.id)) agents.set(target.id, {
      id: target.id, name: target.peerName, label: target.label, agentType: target.agentType,
      phase: 'unknown',
    });
  }
  return { agents, targets };
}

// 与 Claude 原生任务行一致的简短写法：↓ 18.4k · 3m。
function compactCount(count) {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact', maximumFractionDigits: 1, minimumFractionDigits: count >= 1000 ? 1 : 0,
  }).format(count).toLowerCase();
}

// 原生子代理脚本约每 5 秒刷新一次，超过一分钟只显示到分钟，避免秒数跳动。
function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}h${m % 60}m` : m ? `${m}m` : `${s}s`;
}

function taskMeta(task, now) {
  const parts = [];
  if (knownCount(task.tokenCount) && task.tokenCount > 0) parts.push('↓ ' + compactCount(task.tokenCount));
  const elapsed = Number.isFinite(task.startTime) ? fmtElapsed(now - task.startTime) : '';
  if (elapsed) parts.push(elapsed);
  return parts.join(' · ');
}

const cleanAgentText = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim() : '';
// 插件代理类型常带重复前缀（codex:codex-rescue），只去掉与名称重复的那段。
function shortType(value) {
  const match = /^([^:\s]+):(.+)$/.exec(value);
  return match && match[2].toLowerCase().startsWith(match[1].toLowerCase()) ? match[2] : value;
}
const agentName = (agent, task) => shortType(cleanAgentText(task?.name || agent?.name || task?.agentType || agent?.agentType));
const agentDetail = (agent, task) => cleanAgentText(task?.label || task?.description || agent?.label);

// 与主栏 ● kw 同一套颜色：绿色保活中，黄色缓存已冷或插件暂停，灰色空心为关闭、停止或不支持保活。
function agentKeepwarm(target, state, off) {
  if (!target) return { dot: dim('○'), counts: dim(formatKeepwarm()) };
  let round = target.workTurnId || target.bumps === 0 ? target.roundBumps : null;
  if (knownCount(round)) round += serverCount(target.serverKeepaliveCount);
  const total = knownCount(target.bumps) ? target.bumps + serverCount(target.serverKeepaliveTotal) : target.bumps;
  const closed = off || target.manualOff || target.state === 'stopped' || state?.state === 'stopped';
  const paused = !closed && (state?.state === 'paused' || target.state === 'paused');
  const dot = closed ? dim('○') : paused ? '\x1b[33m○\x1b[0m' : target.cold ? '\x1b[33m●\x1b[0m' : '\x1b[32m●\x1b[0m';
  return { dot, counts: dim(formatKeepwarm(total, round)) };
}

const spaces = count => ' '.repeat(Math.max(0, count));

// 名称列和描述列对齐，尾部紧跟最长描述；窄终端截断描述。
function alignAgentRows(items, width) {
  const nameWidth = Math.min(24, Math.max(0, ...items.map(item => strWidth(item.name))));
  const gap = nameWidth ? 2 : 0;
  const leadWidth = Math.max(0, ...items.map(item => strWidth(item.lead)));
  const tailWidth = Math.max(0, ...items.map(item => strWidth(item.tail)));
  const room = Math.max(0, Math.min(Math.max(0, ...items.map(item => strWidth(item.detail))),
    width - leadWidth - nameWidth - gap - 2 - tailWidth));
  return items.map(item => {
    const name = truncateText(item.name, nameWidth), detail = truncateText(item.detail, room);
    return item.lead + dim(name) + spaces(nameWidth - strWidth(name) + gap) + detail + spaces(room - strWidth(detail) + 2) + item.tail;
  });
}

// 名称与描述相同只显示一次，两者都没有时用代理标识。
function agentItem(id, agent, task) {
  const name = agentName(agent, task), detail = agentDetail(agent, task);
  return { name, detail: detail === name ? '' : detail || (name ? '' : id) };
}

// SubAgent:运行:总数，与额度的 ▸ 同一种开关；运行中的代理由 Claude 原生面板显示。
function agentSegment(accounts, id, agents, expanded) {
  const running = [...agents.values()].filter(agent => agent.phase === 'running').length;
  const text = `SubAgent:${running}:${agents.size}`;
  return accounts.toggleLink(id, expanded, 'keepwarm', ' ' + text) || text;
}

// 展开行写法参照额度展开行：行首圆点即保活状态，计数对齐在描述之后。
function agentListRows(agents, targets, state, off, width) {
  const items = [];
  for (const agent of agents.values()) {
    if (agent.phase === 'running') continue;
    const mark = agentKeepwarm(targets.get(agent.id), state, off);
    items.push({ ...agentItem(agent.id, agent), lead: mark.dot + ' ', tail: mark.counts });
  }
  return alignAgentRows(items, width);
}

// 原生子代理行：保留 Claude 自带圆点，内容为名称、描述、保活标记、词元与耗时。
function subagentRows(input) {
  if (!Array.isArray(input.tasks)) return '';
  const state = readKeepwarm(input.session_id);
  const off = keepwarmDisabled();
  const { agents, targets } = keepwarmAgents(state);
  const width = Number(input.columns) > 0 ? Number(input.columns) : Infinity;
  const now = Date.now();
  const tasks = input.tasks.filter(task => validId(task?.id));
  const active = tasks.filter(task => task.status === 'running' || task.status === 'pending');
  const rows = alignAgentRows(active.map(task => {
    const mark = agentKeepwarm(targets.get(task.id), state, off), meta = taskMeta(task, now);
    return { ...agentItem(task.id, agents.get(task.id), task), lead: '', tail: `${mark.dot} ${mark.counts}` + (meta ? '  ' + dim(meta) : '') };
  }), width);
  const content = new Map(active.map((task, index) => [task.id, rows[index]]));
  return tasks.map(task => JSON.stringify({ id: task.id, content: content.get(task.id) ?? '' })).join('\n');
}

// 终端显示宽度：去掉颜色控制符，中日韩全角字符和表情占 2 列
function strWidth(s) {
  let w = 0;
  for (const ch of s.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;]*m/g, '')) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1;
  }
  return w;
}

function truncateText(text, width) {
  if (width <= 0) return '';
  if (strWidth(text) <= width) return text;
  let prefix = '', remaining = width - 1;
  for (const ch of text) {
    remaining -= strWidth(ch);
    if (remaining < 0) break;
    prefix += ch;
  }
  return prefix + '…';
}

// 按宽度把分段排成多行，只在分段之间换行，单个分段不拆开
function wrap(segs, width) {
  const rows = [];
  let row = '';
  for (const seg of segs) {
    if (row && strWidth(row + SEP + seg) > width) { rows.push(row); row = ''; }
    row = row ? row + SEP + seg : seg;
  }
  if (row) rows.push(row);
  return rows;
}

const trimEnd = text => text.replace(/ +$/, '');

// 展开后的额度表：当前虚拟机在首行，各列按最宽值对齐；单行放不下时每台虚拟机拆成 5h、7d 两行，两行共用列宽。
function quotaTable(vms, width) {
  const nameWidth = Math.max(...vms.map(vm => strWidth(vm.name)));
  const widths = parts => ({
    cost: Math.max(0, ...parts.map(p => strWidth(p?.cost ?? ''))),
    reset: Math.max(0, ...parts.map(p => strWidth(p?.reset ?? ''))),
  });
  const cell = (label, p, w) => label + ' ' + (p ? meter(p.pct, 0, 4) : '--'.padStart(4) + spaces(11)) +
    (w.cost ? ' ' + (p?.cost ?? '') + spaces(w.cost - strWidth(p?.cost ?? '')) : '') +
    (w.reset ? ' ' + spaces(w.reset - strWidth(p?.reset ?? '')) + (p?.reset ?? '') : '');
  const lead = vm => vm.lead + ' ' + vm.name + spaces(nameWidth - strWidth(vm.name)) + ' ';
  const five = widths(vms.map(vm => vm.windows[0])), seven = widths(vms.map(vm => vm.windows[1]));
  const single = vms.map(vm => trimEnd(lead(vm) + cell('5h', vm.windows[0], five) + SEP + cell('7d', vm.windows[1], seven)));
  if (Math.max(...single.map(strWidth)) <= width) return single;
  const both = widths(vms.flatMap(vm => vm.windows));
  // Claude 会去掉状态栏每行开头的空格，缩进前放一个空的样式重置，保住 7d 行的列位置。
  const indent = '\x1b[0m' + spaces(strWidth(lead(vms[0])));
  return vms.flatMap(vm => [trimEnd(lead(vm) + cell('5h', vm.windows[0], both)), trimEnd(indent + cell('7d', vm.windows[1], both))]);
}


async function main() {
  const accounts = require('./statusline-accounts');
  const sess = readStdin();
  const model = (sess.model && (sess.model.display_name || sess.model.id)) || '';
  const dir = (sess.workspace && sess.workspace.current_dir) || sess.cwd || process.cwd();
  const sessionId = sess.session_id || '';
  const keepwarm = readKeepwarm(sessionId);
  const off = keepwarmDisabled();
  const { agents, targets } = keepwarmAgents(keepwarm);

  // 模型、目录、分支、保活、子代理、上下文与额度连成一串，按终端宽度在分段之间换行
  const segs = [];
  if (model) segs.push(`\x1b[36m${model}\x1b[0m`);
  const branch = safe(() => gitBranch(dir));
  segs.push(path.basename(dir) + (branch ? ` \x1b[35m⎇ ${branch}\x1b[0m` : ''));
  segs.push(keepwarmStr(sess, keepwarm, off));
  const agentsExpanded = agents.size > 0 && accounts.isExpanded(sessionId, 'keepwarm');
  if (agents.size) segs.push(agentSegment(accounts, sessionId, agents, agentsExpanded));
  const ctx = safe(() => contextUsage(sess));
  if (ctx) segs.push(ctxStr(ctx));
  // 新响应到达时立刻重查会话归属，避免 30 秒缓存掩盖同会话的账号切换。
  const requestMarker = String(sess.cost?.total_api_duration_ms ?? sess.cost?.total_cost_usd ?? '');
  const state = await accounts.quota(sessionId, requestMarker).catch(() => ({ accounts: [], selected: null, expanded: false }));
  const q = state.selected;
  const name = q ? accounts.cleanLabel(q.vm_name || q.vm_id) : '账户待确认';
  const triangle = accounts.toggleLink(sessionId, state.expanded);

  // Claude Code 通过 COLUMNS 传入终端宽度，状态栏左右各占 2 列边距
  const width = (Number(process.env.COLUMNS) || Infinity) - 4;
  const current = { lead: triangle, name, windows: [windowParts(q?.five_hour), windowParts(q?.seven_day)] };
  let rows;
  if (state.expanded) {
    // 当前虚拟机已在首行，表中只追加其余虚拟机；额度表另起一行从首列开始，各列对齐。
    const vms = [current, ...state.accounts.filter(vm => vm.vm_id !== q?.vm_id).map(vm => ({
      lead: '○', name: accounts.cleanLabel(vm.vm_name || vm.vm_id) + (state.cached ? '（缓存）' : ''),
      windows: [windowParts(vm.five_hour), windowParts(vm.seven_day)],
    }))];
    rows = [...wrap(segs, width), ...quotaTable(vms, width)];
    if (!state.accounts.length) rows.push('全部额度暂不可用');
  } else {
    // 5h 与 7d 是同一模块，只在模块之间换行；终端窄到单独一行也放不下时才按对齐表拆成两行。
    const quota = windowStr(`${triangle ? triangle + ' ' : ''}${name} 5h`, q?.five_hour) + SEP + windowStr('7d', q?.seven_day);
    rows = strWidth(quota) <= width ? wrap([...segs, quota], width) : [...wrap(segs, width), ...quotaTable([current], width)];
  }
  if (agentsExpanded) rows.push(...agentListRows(agents, targets, keepwarm, off, width));
  process.stdout.write(rows.join('\n'));
}

if (require.main === module) {
  if (process.argv[2] === '--refresh') {
    refresh().catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  } else if (process.argv[2] === '--subagents') {
    try { process.stdout.write(subagentRows(readStdin())); } catch (_) { /* 由 Claude 回退到原生显示。 */ }
  } else {
    main().catch(() => { try { process.stdout.write('Claude'); } catch (_) {} });
  }
}

module.exports = { windowStr, contextUsage, wrap, strWidth, keepwarmStr, keepwarmAgents, agentSegment, agentListRows, subagentRows };
