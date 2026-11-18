'use strict';

// 双账户额度、当前会话路由和展开状态；旧单账户缓存仍供既有保活插件读取。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readConfig, readJson, writePrivateJson, panelClient, queryFleet, querySessionRoute } = require('./vm2api-quota');

const DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const ROOT = path.join(DIR, 'cache', 'statusline-accounts');
const FLEET = path.join(ROOT, 'fleet.json');
const SESSION = path.join(DIR, 'cache', 'local-statusline-vm2api-session.json');
const LOCK = path.join(ROOT, 'refresh.lock');
const TTL = 29_500;
const STALE = 600_000;
const TIMEOUT = 15_000;
const validSession = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const uuidSession = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const routeFile = id => path.join(ROOT, `route-${id}.json`);
const viewFile = (id, panel) => path.join(ROOT, `${panel === 'keepwarm' ? 'kw-view' : 'view'}-${id}.json`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sourceOf = config => `vm2api-accounts-v1:${config.baseUrl}`;

function cached(file, config) {
  const value = readJson(file);
  return value?._source === sourceOf(config) ? value : {};
}

async function acquireLock() {
  fs.mkdirSync(ROOT, { recursive: true });
  const deadline = Date.now() + TIMEOUT + 1000;
  do {
    try {
      if (Date.now() - fs.statSync(LOCK).mtimeMs > TIMEOUT * 2) fs.unlinkSync(LOCK);
    } catch (_) {}
    try {
      fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await pause(75);
  } while (Date.now() < deadline);
  return false;
}

function errorCode(error) {
  return /^quota_[a-z0-9_]+$/.test(error?.message) ? error.message : 'quota_refresh_failed';
}

async function refresh(sessionId = '', force = false, marker = '') {
  if (sessionId && !validSession(sessionId)) throw new Error('quota_invalid_session');
  if (!await acquireLock()) return;
  try {
    const config = readConfig(DIR);
    const now = Date.now();
    let fleet = cached(FLEET, config);
    const route = validSession(sessionId) ? cached(routeFile(sessionId), config) : {};
    const fleetDue = force || now - (fleet._tried || 0) >= TTL;
    const routeDue = validSession(sessionId) && (force || route._marker !== marker || now - (route._tried || 0) >= TTL);
    if (!fleetDue && !routeDue) return;
    const metadata = { _source: sourceOf(config), _tried: now };
    const routeMetadata = { ...metadata, _marker: marker };
    if (fleetDue) writePrivateJson(FLEET, { ...fleet, ...metadata, _loading: true });
    if (routeDue) writePrivateJson(routeFile(sessionId), { ...route, ...routeMetadata, _loading: true });
    try {
      // 整轮共享超时；后台进程在状态栏被取消后仍可完成缓存写入。
      const request = await panelClient({ config, sessionFile: SESSION, signal: AbortSignal.timeout(TIMEOUT) });
      const jobs = [];
      if (fleetDue) jobs.push((async () => {
        try {
          const data = await queryFleet(request);
          fleet = { ...metadata, _ts: Date.now(), data };
          writePrivateJson(FLEET, fleet);
          // 保留旧缓存格式和固定槽含义，避免破坏既有保活插件的读取契约。
          const legacy = data.find(vm => vm.vm_id === config.vmId && !vm.unavailable);
          if (legacy) writePrivateJson(path.join(DIR, 'cache', 'local-statusline-quota.json'), {
            _source: config.source, _ts: Date.now(), _tried: now, data: legacy,
          });
        } catch (error) {
          writePrivateJson(FLEET, { ...fleet, ...metadata, _loading: false, _error: errorCode(error) });
        }
      })());
      if (routeDue) jobs.push((async () => {
        try {
          const data = await querySessionRoute(request, sessionId);
          writePrivateJson(routeFile(sessionId), { ...routeMetadata, _ts: Date.now(), data });
        } catch (error) {
          // 查询失败后不拿旧路由推测当前账户；全量额度可继续展示有时效的缓存。
          writePrivateJson(routeFile(sessionId), { ...routeMetadata, _error: errorCode(error), data: null });
        }
      })());
      await Promise.all(jobs);
    } catch (error) {
      if (fleetDue) writePrivateJson(FLEET, { ...fleet, ...metadata, _loading: false, _error: errorCode(error) });
      if (routeDue) writePrivateJson(routeFile(sessionId), { ...routeMetadata, _error: errorCode(error), data: null });
    }
  } finally {
    if (readLock() === String(process.pid)) {
      try { fs.unlinkSync(LOCK); } catch (_) {}
    }
  }
}

function readLock() {
  try { return fs.readFileSync(LOCK, 'utf8'); } catch (_) { return ''; }
}

function snapshot(sessionId, config = readConfig(DIR), now = Date.now()) {
  const fleet = cached(FLEET, config);
  const route = validSession(sessionId) ? cached(routeFile(sessionId), config) : {};
  const accounts = Array.isArray(fleet.data) && now - fleet._ts < STALE ? fleet.data : [];
  const selected = route.data && now - route._ts < STALE ? accounts.find(vm =>
    vm.vm_id === route.data.vm_id && vm.account_id === route.data.account_id) : null;
  return { accounts, selected: selected || null, route: selected ? route.data : null,
    expanded: isExpanded(sessionId),
    cached: !!fleet._error, fleet, routeCache: route };
}

async function quota(sessionId, marker = '') {
  const config = readConfig(DIR);
  const state = snapshot(sessionId, config);
  const now = Date.now();
  if (now - (state.fleet._tried || 0) >= TTL ||
      (validSession(sessionId) && (state.routeCache._marker !== marker || now - (state.routeCache._tried || 0) >= TTL))) {
    // 渲染必须立即退出：Claude 会取消跨过下一次重绘的进程及其子孙进程。
    // 不等待后台进程并解除引用，退出后后台刷新由系统接管，慢接口也能写完缓存。
    const lockPid = Number(readLock());
    let running = false;
    if (lockPid > 0) {
      try {
        process.kill(lockPid, 0);
        running = Date.now() - fs.statSync(LOCK).mtimeMs < TIMEOUT * 2;
      } catch (_) {}
    }
    if (!running) {
      const child = spawn(process.execPath, [__filename, '--refresh', validSession(sessionId) ? sessionId : '', marker], {
        env: process.env, detached: true, stdio: 'ignore',
      });
      child.once('error', () => {});
      child.unref();
    }
  }
  return snapshot(sessionId, config);
}

function isExpanded(sessionId, panel) {
  return validSession(sessionId) && readJson(viewFile(sessionId, panel))?.expanded === true;
}

function toggle(sessionId, panel) {
  if (!validSession(sessionId)) throw new Error('quota_invalid_session');
  const file = viewFile(sessionId, panel);
  const expanded = !isExpanded(sessionId, panel);
  writePrivateJson(file, { expanded, updated_at: Date.now() });
  return expanded;
}

function handleUri(uri) {
  // 仅接收两种原始链接，拒绝路径折叠、编码和查询参数。
  const link = typeof uri === 'string' && /^claude-quota:\/\/(toggle|keepwarm)\/([a-zA-Z0-9_-]{1,128})$/.exec(uri);
  if (!link) throw new Error('quota_invalid_link');
  const key = link[2];
  if (link[1] === 'toggle' && key.startsWith('kw_') && uuidSession.test(key.slice(3))) {
    return toggle(key.slice(3), 'keepwarm');
  }
  return toggle(key, link[1]);
}

function cleanLabel(value) {
  // 面板名称属于外部数据，剔除终端控制符和换行，防止破坏状态栏。
  return String(value || '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 64);
}

function toggleLink(sessionId, expanded, panel, title = '') {
  if (!validSession(sessionId)) return '';
  // 已运行的 Tabby 只识别 toggle 路由。Claude 会话使用 UUID，带 kw_ 的标识可与额度链接区分。
  const destination = panel !== 'keepwarm' ? `toggle/${sessionId}`
    : uuidSession.test(sessionId) ? `toggle/kw_${sessionId}` : `keepwarm/${sessionId}`;
  const label = (expanded ? '▾' : '▸') + title;
  return `\x1b]8;;claude-quota://${destination}\x1b\\${label}\x1b]8;;\x1b\\`;
}

if (require.main === module) {
  const [command, value] = process.argv.slice(2);
  if (command === '--refresh') refresh(value || '', process.argv.includes('--force'), process.argv[4] === '--force' ? '' : process.argv[4] || '').catch(() => { process.exitCode = 1; });
  else {
    try {
      if (command === '--handle-uri') handleUri(value);
      else if (command === '--toggle') process.stdout.write(toggle(value) ? '已展开\n' : '已收起\n');
      else throw new Error('quota_invalid_command');
    } catch (error) { process.stderr.write(errorCode(error) + '\n'); process.exitCode = 1; }
  }
}

module.exports = { quota, refresh, snapshot, toggle, handleUri, toggleLink, isExpanded, cleanLabel, validSession };
