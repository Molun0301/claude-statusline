#!/usr/bin/env node
/*
 * local-statusline.js — Claude Code 底部状态栏。
 *
 * 显示内容：
 *   第一行  模型 │ 目录 ⎇ git 分支 │ kw 状态与次数
 *   第二行  当前会话上下文占用 │ 实际请求虚拟机及账户的 5 小时 / 7 天额度 │ 展开/收起
 *   展开行  每个 Claude 虚拟机的完整额度（展开状态按当前会话保存）
 * 终端宽度不够时按 Claude Code 传入的 COLUMNS 在分段之间自动换行。
 *
 * 额度来自 vm2api 网页面板接口，显示已用比例、窗口记录金额/预计容量和距重置时间。
 * 预计容量按已记录美元金额除以当前已用比例估算，以 ≈ 标记；不是官方订阅扣费。
 * 站点与槽位由相邻 local-statusline-quota-config.json 配置，登录信息复用既有私密文件。
 *
 * settings.json 的 statusLine.refreshInterval 每 2 秒触发本地渲染，点击展开最长约 2 秒生效。
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
const { spawn } = require('child_process');
const { readConfig, readJson, writePrivateJson, queryQuota } = require('./vm2api-quota');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CACHE = path.join(CLAUDE_DIR, 'cache', 'local-statusline-quota.json');
const SESSION = path.join(CLAUDE_DIR, 'cache', 'local-statusline-vm2api-session.json');
const LOCK = CACHE + '.lock';
const TTL_MS = 30_000;
const REFRESH_AFTER_MS = TTL_MS - 500;       // 容许调度抖动，避免相差几毫秒就跳过整轮
const STALE_MS = 10 * 60_000;                // 更旧的缓存不再显示
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

// 后台子进程：请求额度接口并写缓存；失败时保留旧数据
async function refresh(force = false) {
  if (!acquireRefreshLock()) return;
  try {
    const config = readConfig(CLAUDE_DIR);
    const cached = readCache() || {};
    const now = Date.now();
    if (!force && now - (cached._tried || 0) < REFRESH_AFTER_MS) return;
    const attempted = { ...cached, _source: config.source, _tried: now };
    writeCache(attempted);
    try {
      const data = await queryQuota({ config, sessionFile: SESSION, signal: AbortSignal.timeout(TIMEOUT_MS) });
      writeCache({ _source: config.source, _ts: Date.now(), _tried: now, data });
    } catch (error) {
      // 仅记录本地定义的错误码，接口正文和登录凭据不进入日志。
      const code = /^quota_[a-z0-9_]+$/.test(error.message) ? error.message : 'quota_refresh_failed';
      writeCache({ ...attempted, _error: code });
      if (force) throw new Error(code);
    }
  } finally {
    if (safe(() => fs.readFileSync(LOCK, 'utf8')) === String(process.pid)) {
      try { fs.unlinkSync(LOCK); } catch (_) {}
    }
  }
}

async function quota(now) {
  let cached = readCache() || {};
  // 以上次请求开始时间限流，避免请求耗时使下一次 30 秒调度跳过刷新。
  if (now - (cached._tried || 0) >= REFRESH_AFTER_MS) {
    await new Promise((resolve) => {
      // 独立进程在状态栏被 Claude 取消后仍能完成请求；本轮正常执行则等待新值。
      const child = spawn(process.execPath, [__filename, '--refresh-background'], { detached: true, stdio: 'ignore' });
      child.once('error', resolve);
      child.once('exit', resolve);
    });
    cached = readCache() || {};
  }
  return cached.data && now - cached._ts < STALE_MS ? cached.data : null;
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
// 已用比例 + 进度条，按占用程度着色
function meter(pct, digits = 0) {
  const color = pct < 50 ? '\x1b[32m' : pct < 80 ? '\x1b[33m' : '\x1b[31m';
  return `${color}${pct.toFixed(digits)}% ${bar(pct)}\x1b[0m`;
}
function ctxStr(c) {
  return `ctx ${meter(c.pct, c.pct < 10 ? 1 : 0)} ${fmtNum(c.used)}/${fmtNum(c.size)}`;
}
function windowStr(label, w) {
  // 旧缓存也在重置时立即归零，不等待服务端建立下一窗口。
  if (w?.reset_at && Date.parse(w.reset_at) <= Date.now()) return `${label} ${meter(0)}`;
  if (!w || w.stale || w.used_percent == null) return `${label} --`;
  if (!w.reset_at && w.used_percent !== 0) return `${label} --`;
  let cost = '';
  if (w.used_cost != null) {
    cost = ' ' + fmtCost(w.used_cost);
    if (w.estimated_total_cost != null) cost += '/≈' + fmtCost(w.estimated_total_cost);
    else {
      const reason = { low_usage: '低用量' }[w.estimate_status];
      if (reason) cost += `（${reason}）`;
    }
  }
  const reset = fmtReset(w.reset_at);
  return `${label} ${meter(w.used_percent)}${cost}` + (reset ? ` ${reset}` : '');
}

// 只读取当前会话：绿点开启，黄点等待，黄色空心点暂停，灰色空心点关闭。
function keepwarmStr(sess) {
  const home = path.join(os.homedir(), '.claude'); // 插件固定把状态写在此处
  const id = String(sess.session_id || '');
  const state = /^[a-zA-Z0-9_-]+$/.test(id)
    ? readJson(path.join(home, 'keepwarm', 'sessions', `${id}.json`)) : null;
  const settings = readJson(path.join(CLAUDE_DIR, 'settings.json'));
  const off = settings?.enabledPlugins?.['keepwarm@keepwarm'] === false || fs.existsSync(path.join(home, 'keepwarm-off'));
  const count = Number.isSafeInteger(state?.bumps) && state.bumps >= 0 ? state.bumps : '-';
  const round = Number.isSafeInteger(state?.roundBumps) && state.roundBumps >= 0 ? state.roundBumps : '-';
  // 状态缺失不当作关闭或零次，避免显示其他会话的旧计数。
  if (!off && !['active', 'paused', 'stopped'].includes(state?.state)) return '\x1b[2mkw?\x1b[0m';
  const stopped = off || state?.state === 'stopped';
  const paused = state?.state === 'paused';
  const color = stopped ? '\x1b[2m' : paused || state?.cold ? '\x1b[33m' : '\x1b[32m';
  return `\x1b[2mkw\x1b[0m${color}${stopped || paused ? '○' : '●'}${count}\x1b[2m·${round}\x1b[0m`;
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

async function main() {
  const accounts = require('./statusline-accounts');
  const sess = readStdin();
  const model = (sess.model && (sess.model.display_name || sess.model.id)) || '';
  const dir = (sess.workspace && sess.workspace.current_dir) || sess.cwd || process.cwd();

  // 第一行：模型、目录、分支与保活；第二行：上下文与额度
  const head = [];
  if (model) head.push(`\x1b[36m${model}\x1b[0m`);
  const branch = safe(() => gitBranch(dir));
  head.push(path.basename(dir) + (branch ? ` \x1b[35m⎇ ${branch}\x1b[0m` : ''));
  head.push(keepwarmStr(sess));
  const stats = [];
  const ctx = safe(() => contextUsage(sess));
  if (ctx) stats.push(ctxStr(ctx));
  const sessionId = sess.session_id || '';
  // 新响应到达时立刻重查会话归属，避免 30 秒缓存掩盖同会话的账号切换。
  const requestMarker = String(sess.cost?.total_api_duration_ms ?? sess.cost?.total_cost_usd ?? '');
  const state = await accounts.quota(sessionId, requestMarker).catch(() => ({ accounts: [], selected: null, expanded: false }));
  const q = state.selected;
  const name = q ? accounts.cleanLabel(q.vm_name || q.vm_id) : '账户待确认';
  const triangle = accounts.toggleLink(sessionId, state.expanded);
  stats.push(windowStr(`${triangle ? triangle + ' ' : ''}${name} 5h`, q?.five_hour), windowStr('7d', q?.seven_day));

  // Claude Code 通过 COLUMNS 传入终端宽度，状态栏左右各占 2 列边距
  const width = (Number(process.env.COLUMNS) || Infinity) - 4;
  const rows = [...wrap(head, width), ...wrap(stats, width)];
  if (state.expanded) {
    for (const vm of state.accounts) {
      // 当前虚拟机已在主行完整显示，展开区域只补充其余虚拟机。
      if (vm.vm_id === q?.vm_id) continue;
      const label = '○ ' + accounts.cleanLabel(vm.vm_name || vm.vm_id) + (state.cached ? '（缓存）' : '');
      rows.push(...wrap([windowStr(`${label} 5h`, vm.five_hour), windowStr('7d', vm.seven_day)], width));
    }
    if (!state.accounts.length) rows.push('全部额度暂不可用');
  }
  process.stdout.write(rows.join('\n'));
}

if (require.main === module) {
  if (process.argv[2] === '--refresh' || process.argv[2] === '--refresh-background') {
    const force = process.argv[2] === '--refresh';
    refresh(force).catch((error) => {
      if (force) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      }
    });
  } else {
    main().catch(() => { try { process.stdout.write('Claude'); } catch (_) {} });
  }
}

module.exports = { windowStr, contextUsage, wrap, strWidth, keepwarmStr };
