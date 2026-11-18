'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/local-statusline.js'), 'utf8');
const clean = text => text.replace(/\x1b\[[0-9;]*m/g, '');

// 状态文件、配置和全局开关都由内存接管，不读取账号，不发网络请求。
function harness(states, { off = false, disabled = false, expanded = false } = {}) {
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
        writePrivateJson: (file, value) => files.set(file, value),
        queryQuota: () => { throw Error('不应读取网络额度'); },
      };
      if (name === './statusline-accounts') return {
        isExpanded: () => expanded,
        toggleLink: (id, open, panel, title = '') => (open ? '▾' : '▸') + title,
      };
      return require(name);
    },
  };
  vm.runInNewContext(source, sandbox);
  return {
    show: id => clean(module.exports.keepwarmStr({ session_id: id })),
    agents: (id, tasks, columns = 100) => module.exports.subagentRows({ session_id: id, tasks, columns }).split('\n').map(JSON.parse),
    segment: id => {
      const { agents } = module.exports.keepwarmAgents(states[id]);
      return clean(module.exports.agentSegment(sandbox.require('./statusline-accounts'), id, agents, expanded));
    },
    list: (id, columns = 100) => {
      const { agents, targets } = module.exports.keepwarmAgents(states[id]);
      return module.exports.agentListRows(agents, targets, states[id], off || disabled, columns);
    },
    width: module.exports.strWidth,
    reads,
  };
}

test('紧凑显示会话累计和主代理本轮，兼容旧快照里的主代理分项', () => {
  const previous = { version: 4, state: 'active', bumps: 23, roundBumps: 9, targets: [{ id: 'main', roundBumps: 2 }] };
  const h = harness({ previous, current: { ...previous, mainRoundBumps: 3 } });
  assert.equal(h.show('previous'), '● kw:2:23');
  assert.equal(h.show('current'), '● kw:3:23');
});

test('本轮零次与累计零次都显示0', () => {
  const h = harness({ current: { state: 'active', bumps: 0, mainRoundBumps: 0 } });
  assert.equal(h.show('current'), '● kw:0:0');
});

test('旧版缺少主代理分项时保留未知', () => {
  const h = harness({ current: { state: 'active', bumps: 23, roundBumps: 7 } });
  assert.equal(h.show('current'), '● kw:-:23');
});

test('暂停和停止保留两个计数并显示空心圆点', () => {
  for (const state of ['paused', 'stopped']) {
    const h = harness({ current: { state, bumps: 23, mainRoundBumps: 2 } });
    assert.equal(h.show('current'), '○ kw:2:23');
  }
});

test('全局关闭与插件禁用仍保留两个数字', () => {
  for (const options of [{ off: true }, { disabled: true }]) {
    const h = harness({ current: { state: 'active', bumps: 23, mainRoundBumps: 2 } }, options);
    assert.equal(h.show('current'), '○ kw:2:23');
  }
});

test('非法计数保持未知，不显示负数或小数', () => {
  for (const mainRoundBumps of [-1, 1.5, null, '2']) {
    const h = harness({ current: { state: 'active', bumps: 23, mainRoundBumps } });
    assert.equal(h.show('current'), '● kw:-:23');
  }
});

test('两个会话的计数分别读取，不回退到其他会话', () => {
  const h = harness({ first: { state: 'active', bumps: 23, mainRoundBumps: 2 }, second: { state: 'active', bumps: 7, mainRoundBumps: 0 }, mismatch: { sessionId: 'first', bumps: 23 } });
  assert.equal(h.show('first'), '● kw:2:23');
  assert.equal(h.show('second'), '● kw:0:7');
  assert.equal(h.show('missing'), 'kw:-:-');
  assert.equal(h.show('mismatch'), 'kw:-:-');
});

test('非法会话标识不能读取其他状态文件', () => {
  const h = harness({ first: { state: 'active', bumps: 23, roundBumps: 2 } });
  assert.equal(h.show('../first'), 'kw:-:-');
  assert(!h.reads.some(file => file.includes('/keepwarm/sessions/')));
});

const demo = { state: 'active',
  agentViews: [{ id: 'A', label: '第一项', phase: 'running' }, { id: 'B', phase: 'running' },
    { id: 'C', name: '稍长的代理名', label: '收起的代理', phase: 'closed' }],
  targets: [{ id: 'A', bumps: 9, roundBumps: 2, workTurnId: 't1' }, { id: 'B', bumps: 4, roundBumps: 1, workTurnId: 't2', manualOff: true }],
};
const started = Date.now();
const tasks = [
  { id: 'B', name: '同名代理', label: '执行\x1b\x07\n任务', status: 'running', startTime: started - 60_000, tokenCount: 1250 },
  { id: 'A', name: '同名代理', label: '另一任务', status: 'running', startTime: started - 125_000, tokenCount: 10_030 },
  { id: 'C', name: '关闭的代理', status: 'killed', startTime: started },
];

test('原生工作行显示保活标记、词元与耗时，不再附加按钮', () => {
  const h = harness({ demo });
  const rows = h.agents('demo', tasks);
  assert.deepEqual(rows.map(row => row.id), ['B', 'A', 'C']);
  assert.equal(clean(rows[0].content), '同名代理  执行任务  ○ kw:1:4  ↓ 1.3k · 1m');
  assert.equal(clean(rows[1].content), '同名代理  另一任务  ● kw:2:9  ↓ 10.0k · 2m');
  assert.equal(rows[2].content, '');
  assert(!rows.some(row => row.content.includes('子代理') || row.content.includes('\n') || row.content.includes('\x07')));
  const narrow = h.agents('demo', tasks, 34);
  assert.match(clean(narrow[0].content), /○ kw:1:4  ↓ 1\.3k/);
  assert.match(clean(narrow[1].content), /● kw:2:9  ↓ 10\.0k/);
  assert(h.width(clean(narrow[1].content)) <= 34);
});

test('状态栏分段与额度开关同一写法，展开后三角朝下并列出未在运行的代理', () => {
  const closed = harness({ demo });
  assert.equal(closed.segment('demo'), '▸ SubAgent:2:3');
  const opened = harness({ demo }, { expanded: true });
  assert.equal(opened.segment('demo'), '▾ SubAgent:2:3');
  const rows = opened.list('demo');
  assert.equal(rows.length, 1);
  assert.equal(clean(rows[0]), '○ 稍长的代理名  收起的代理  kw:-:-');
});

test('展开行以保活圆点开头，沿用主栏配色，计数列对齐，插件代理去掉重复前缀', () => {
  const state = { state: 'active', agentViews: [
    { id: 'warm', agentType: 'codex:codex-rescue', label: '保活中', phase: 'completed' },
    { id: 'cold', agentType: 'frontend-design:reviewer', label: '缓存已冷的较长描述', phase: 'completed' },
    { id: 'off', agentType: 'general-purpose', label: '已关闭', phase: 'completed' },
    { id: 'same', agentType: 'Explore', label: 'Explore', phase: 'closed' },
  ], targets: [{ id: 'warm', bumps: 3, roundBumps: 1, workTurnId: 'w' }, { id: 'cold', bumps: 0, roundBumps: 0, cold: true },
    { id: 'off', bumps: 2, roundBumps: 0, workTurnId: 'w', manualOff: true }] };
  const h = harness({ state });
  const rows = h.list('state');
  const plain = rows.map(clean);
  assert.match(plain[0], /^● codex-rescue +保活中 +kw:1:3$/);
  assert.match(plain[1], /^● frontend-design:reviewer +缓存已冷的较长描述  kw:0:0$/);
  assert.match(plain[3], /^○ Explore +kw:-:-$/);
  assert.equal(new Set(plain.map(row => h.width(row.slice(0, row.indexOf('kw:'))))).size, 1);
  assert(rows[0].startsWith('\x1b[32m●'));
  assert(rows[1].startsWith('\x1b[33m●'));
  assert(rows[2].startsWith('\x1b[2m○'));
  const narrow = h.list('state', 40).map(clean);
  assert(narrow.every(row => h.width(row) <= 40));
});
