'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/local-statusline.js'), 'utf8');
const clean = text => text.replace(/\x1b\[[0-9;]*m/g, '');

// 状态文件、配置和全局开关都由内存接管，不读取账号，不发网络请求。
function harness(states, { off = false, disabled = false } = {}) {
  const files = new Map(Object.entries(states).map(([id, state]) => [`/mock/.claude/keepwarm/sessions/${id}.json`, state]));
  files.set('/mock/.claude/settings.json', { enabledPlugins: { 'keepwarm@keepwarm': !disabled } });
  const reads = [];
  const module = { exports: {} };
  const sandbox = {
    module, __filename: '/mock/local-statusline.js',
    process: { env: {}, cwd: () => '/mock' },
    require: name => {
      if (name === 'fs') return { existsSync: file => off && file === '/mock/.claude/keepwarm-off' };
      if (name === 'os') return { homedir: () => '/mock' };
      if (name === 'child_process') return { spawn: () => { throw Error('不应启动后台进程'); } };
      if (name === './vm2api-quota') return {
        readJson: file => { reads.push(file); return files.get(file) ?? null; },
        queryQuota: () => { throw Error('不应读取网络额度'); },
      };
      return require(name);
    },
  };
  vm.runInNewContext(source, sandbox);
  return { show: id => clean(module.exports.keepwarmStr({ session_id: id })), reads };
}

test('紧凑显示累计与本轮两个数字', () => {
  const h = harness({ current: { state: 'active', bumps: 23, roundBumps: 2 } });
  assert.equal(h.show('current'), 'kw●23·2');
});

test('本轮零次与累计零次都显示0', () => {
  const h = harness({ current: { state: 'active', bumps: 0, roundBumps: 0 } });
  assert.equal(h.show('current'), 'kw●0·0');
});

test('旧版没有本轮记录时显示未知，不拿累计冒充本轮', () => {
  const h = harness({ current: { state: 'active', bumps: 23 } });
  assert.equal(h.show('current'), 'kw●23·-');
});

test('暂停和停止保留两个计数并显示空心圆点', () => {
  for (const state of ['paused', 'stopped']) {
    const h = harness({ current: { state, bumps: 23, roundBumps: 2 } });
    assert.equal(h.show('current'), 'kw○23·2');
  }
});

test('全局关闭与插件禁用仍保留两个数字', () => {
  for (const options of [{ off: true }, { disabled: true }]) {
    const h = harness({ current: { state: 'active', bumps: 23, roundBumps: 2 } }, options);
    assert.equal(h.show('current'), 'kw○23·2');
  }
});

test('非法计数保持未知，不显示负数或小数', () => {
  for (const roundBumps of [-1, 1.5, null, '2']) {
    const h = harness({ current: { state: 'active', bumps: 23, roundBumps } });
    assert.equal(h.show('current'), 'kw●23·-');
  }
});

test('两个会话的计数分别读取，不回退到其他会话', () => {
  const h = harness({ first: { state: 'active', bumps: 23, roundBumps: 2 }, second: { state: 'active', bumps: 7, roundBumps: 0 } });
  assert.equal(h.show('first'), 'kw●23·2');
  assert.equal(h.show('second'), 'kw●7·0');
  assert.equal(h.show('missing'), 'kw?');
});

test('非法会话标识不能读取其他状态文件', () => {
  const h = harness({ first: { state: 'active', bumps: 23, roundBumps: 2 } });
  assert.equal(h.show('../first'), 'kw?');
  assert(!h.reads.some(file => file.includes('/keepwarm/sessions/')));
});
