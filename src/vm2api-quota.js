'use strict';

// 读取 vm2api 网页面板接口。此模块只负责登录、读取及字段转换。
const fs = require('fs');
const path = require('path');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writePrivateJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function readConfig(claudeDir) {
  const raw = readJson(path.join(claudeDir, 'local-statusline-quota-config.json'));
  if (!raw?.base_url || !raw.vm_id || !raw.credentials_file) throw new Error('quota_config_missing');
  const url = new URL(raw.base_url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('quota_config_invalid');
  }
  return {
    baseUrl: url.origin,
    vmId: String(raw.vm_id),
    credentialsFile: raw.credentials_file,
    source: `vm2api:${url.origin}:${raw.vm_id}`,
  };
}

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function resetTime(value) {
  if (value == null || value === '') return null;
  const n = finite(value);
  const ms = n == null ? Date.parse(value) : n < 1e11 ? n * 1000 : n;
  return Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : null;
}

function normalizeWindow(vm, name, now) {
  const ratio = finite(vm[`utilization_${name}`]);
  const reset = resetTime(vm[`reset_${name}`]);
  const estimate = vm[`estimate_${name}`] || {};
  const spent = finite(estimate.spent_usd);
  const total = finite(estimate.total_usd);
  // 已到重置时间就属于空的新窗口；服务端可能要等下一次使用才更新计时。
  const resetElapsed = !!reset && Date.parse(reset) <= now;
  const idle = ratio === 0 && (vm[`reset_${name}`] == null || vm[`reset_${name}`] === '');
  const empty = resetElapsed || idle;
  const stale = !empty && (ratio == null || ratio < 0 || !reset);
  return {
    used_percent: empty ? 0 : stale ? null : Math.min(100, ratio * 100),
    reset_at: reset,
    reset_elapsed: resetElapsed,
    stale,
    used_cost: empty ? 0 : spent != null && spent >= 0 ? spent : null,
    estimated_total_cost: !empty && !stale && estimate.status === 'ok' && total >= 0 && spent != null && total >= spent
      ? total : null,
    estimate_status: empty ? 'reset' : estimate.status || 'no_data',
  };
}

function normalizeVm(data, vmId, now = Date.now()) {
  const vm = data?.vm;
  const account = data?.account;
  // 槽位详情已由服务端按当前账号关联，额外核对身份，避开 usage 列表里的占位账户。
  if (!vm || vm.id !== vmId || !vm.has_token || !vm.account_uuid ||
      account?.account_id !== vm.account_uuid) {
    throw new Error('quota_account_unavailable');
  }
  return {
    vm_id: vmId,
    vm_name: String(vm.name || vmId),
    account_id: account.account_id,
    five_hour: normalizeWindow(vm, '5h', now),
    seven_day: normalizeWindow(vm, '7d', now),
  };
}

async function panelClient({ config, sessionFile, signal, fetchImpl = fetch }) {
  const credentials = readJson(config.credentialsFile);
  const username = credentials?.['用户名'];
  const password = credentials?.['密码'];
  if (!username || !password) throw new Error('quota_credentials_missing');
  // 登录信息须属于当前配置的站点，避免误把凭据提交给另一个地址。
  const savedOrigin = (() => {
    try { return new URL(credentials['管理页面']).origin; } catch (_) { return null; }
  })();
  if (savedOrigin !== config.baseUrl) throw new Error('quota_credentials_origin_mismatch');

  async function request(endpoint, options = {}) {
    let response;
    try {
      response = await fetchImpl(config.baseUrl + endpoint, {
        ...options, signal, redirect: 'error',
        headers: { accept: 'application/json', ...options.headers },
      });
    } catch (_) {
      throw new Error(signal?.aborted ? 'quota_timeout' : 'quota_network_error');
    }
    if (!response.ok) {
      const error = new Error(`quota_http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    let body;
    try { body = await response.json(); } catch (_) { throw new Error('quota_invalid_json'); }
    if (body?.ok !== true) throw new Error('quota_invalid_response');
    return body;
  }

  async function login() {
    const body = await request('/api/panel/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (typeof body.token !== 'string' || !body.token) throw new Error('quota_login_failed');
    const expires = finite(body.expires_in);
    const session = {
      origin: config.baseUrl, username, token: body.token,
      expires_at: Date.now() + Math.max(0, expires || 0) * 1000,
    };
    writePrivateJson(sessionFile, session);
    return session;
  }

  let session = readJson(sessionFile);
  const reused = session?.origin === config.baseUrl && session.username === username &&
    typeof session.token === 'string' && session.token && session.expires_at > Date.now() + 30_000;
  if (!reused) session = await login();
  return async (endpoint) => {
    const read = () => request(endpoint, { headers: { authorization: `Bearer ${session.token}` } });
    try { return await read(); } catch (error) {
      // 只有复用会话被拒时重新登录一次；新会话仍失败就交给下一轮刷新。
      if (!reused || ![401, 403].includes(error.status)) throw error;
      session = await login();
      return read();
    }
  };
}

async function queryQuota(options) {
  const request = await panelClient(options);
  const body = await request(`/api/panel/vms/${encodeURIComponent(options.config.vmId)}`);
  return normalizeVm(body.data, options.config.vmId);
}

async function queryFleet(request) {
  const body = await request('/api/panel/vms');
  if (!Array.isArray(body.data?.items)) throw new Error('quota_invalid_response');
  const slots = body.data.items.filter(vm => vm.platform === 'anthropic' && vm.has_token && vm.account_uuid);
  const results = await Promise.allSettled(slots.map(async vm => {
    const detail = await request(`/api/panel/vms/${encodeURIComponent(vm.id)}`);
    const quota = normalizeVm(detail.data, vm.id);
    // 列表与详情之间可能重新绑定账号；身份变化时不使用任何旧额度。
    if (quota.account_id !== vm.account_uuid) throw new Error('quota_account_changed');
    return { ...quota, updated_at: Date.now() };
  }));
  return slots.map((vm, i) => results[i].status === 'fulfilled' ? results[i].value : {
    vm_id: vm.id, vm_name: String(vm.name || vm.id), account_id: vm.account_uuid,
    unavailable: true,
  });
}

async function querySessionRoute(request, sessionId) {
  const params = new URLSearchParams({ session_id: sessionId, status_code: '200', limit: '20' });
  const body = await request(`/api/panel/usage-logs?${params}`);
  if (!Array.isArray(body.data?.logs)) throw new Error('quota_invalid_response');
  // 服务端同时检索入站和出站会话；必须再次核对入站 ID，不能选全局最新请求。
  const rows = body.data.logs.filter(row => row.clientSessionId === sessionId &&
    row.statusCode >= 200 && row.statusCode < 300 && row.vmId && row.accountId);
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const row = rows[0];
  return row ? { vm_id: row.vmId, account_id: row.accountId,
    request_id: row.requestId, requested_at: row.createdAt } : null;
}

module.exports = { readConfig, readJson, writePrivateJson, resetTime, normalizeVm, queryQuota, panelClient, queryFleet, querySessionRoute };
