'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVm } = require(require('node:path').join(__dirname, '../src/vm2api-quota.js'));
const { windowStr } = require(require('node:path').join(__dirname, '../src/local-statusline.js'));

// 只调用纯数据转换和显示函数，不读取凭据、不发网络或模型请求。
const clean = text => text.replace(/\x1b\[[0-9;]*m/g, '');
function sample(fields, now = Date.now()) {
  return normalizeVm({
    vm: { id: '模拟槽位', has_token: true, account_uuid: '模拟账号', ...fields },
    account: { account_id: '模拟账号' },
  }, '模拟槽位', now);
}

test('5小时和周限额到期后同时归零，不沿用旧窗口金额或预估容量', () => {
  const now = Date.now(), reset = new Date(now - 1000).toISOString();
  const result = sample({
    utilization_5h: 0.96, reset_5h: reset,
    utilization_7d: 0.88, reset_7d: reset,
    estimate_5h: { status: 'ok', spent_usd: 40, total_usd: 44 },
    estimate_7d: { status: 'ok', spent_usd: 280, total_usd: 318 },
  }, now);
  for (const [label, value] of [['5h', result.five_hour], ['7d', result.seven_day]]) {
    assert.equal(value.used_percent, 0);
    assert.equal(value.stale, false);
    assert.equal(value.reset_elapsed, true);
    assert.equal(value.reset_at, reset);
    assert.equal(value.used_cost, 0);
    assert.equal(value.estimated_total_cost, null);
    assert.match(clean(windowStr(label, value)), new RegExp(`^${label} 0% `));
    assert(!clean(windowStr(label, value)).includes('--'));
  }
});

test('精确到达重置时刻也按0%处理', () => {
  const now = Date.now();
  const value = sample({ utilization_5h: 1, reset_5h: new Date(now).toISOString() }, now).five_hour;
  assert.equal(value.used_percent, 0);
  assert.equal(value.reset_elapsed, true);
});

test('新窗口明确0%但尚无重置时刻，不捏造计时', () => {
  const result = sample({ utilization_5h: 0, reset_5h: null, utilization_7d: 0, reset_7d: '' });
  for (const [label, value] of [['5h', result.five_hour], ['7d', result.seven_day]]) {
    assert.equal(value.used_percent, 0);
    assert.equal(value.stale, false);
    assert.equal(value.reset_at, null);
    assert.equal(value.reset_elapsed, false);
    assert.match(clean(windowStr(label, value)), new RegExp(`^${label} 0% `));
    assert(!clean(windowStr(label, value)).includes('now'));
  }
});

test('只归零已到期的窗口，另一窗口的真实用量和时间不变', () => {
  const now = Date.now(), future = new Date(now + 3600000).toISOString();
  const result = sample({ utilization_5h: 0.95, reset_5h: now - 1, utilization_7d: 0.85, reset_7d: future }, now);
  assert.equal(result.five_hour.used_percent, 0);
  assert.equal(result.seven_day.used_percent, 85);
  assert.equal(result.seven_day.reset_at, future);
  assert.equal(result.seven_day.reset_elapsed, false);
});

test('保留真正未知和默认占位数据的空值', () => {
  for (const fields of [
    {}, { utilization_5h: null, reset_5h: null },
    { utilization_5h: -1, reset_5h: 0 },
    { utilization_5h: 0.95, reset_5h: null },
    { utilization_5h: 0, reset_5h: '错误时间' },
  ]) {
    const value = sample(fields).five_hour;
    assert.equal(value.used_percent, null);
    assert.equal(value.stale, true);
    assert.equal(clean(windowStr('5h', value)), '5h --');
  }
});

test('旧缓存已经被转成null时，显示层仍按已知到期时间立即归零', () => {
  const reset = new Date(Date.now() - 1000).toISOString();
  assert.match(clean(windowStr('5h', { used_percent: null, stale: true, reset_at: reset })), /^5h 0% /);
  assert.match(clean(windowStr('7d', { used_percent: 99, stale: false, reset_at: reset })), /^7d 0% /);
});

test('服务端秒时间戳到期且比例缺失时，仍能确认旧窗口已经结束', () => {
  const now = Date.now();
  const value = sample({ utilization_5h: null, reset_5h: String(Math.floor(now / 1000) - 1) }, now).five_hour;
  assert.equal(value.used_percent, 0);
  assert.equal(value.reset_elapsed, true);
  assert.equal(value.stale, false);
});

test('账号身份核对仍然有效', () => {
  assert.throws(() => sample({ account_uuid: '另一个账号' }), /quota_account_unavailable/);
});
