'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(require('node:os').homedir(), '.claude');
const root = path.join(__dirname, '../integrations/tabby-local-path-links');
const { quotaLinkHandler } = require(root + '/claude-quota');

function fixture() {
  const launched = [], forwarded = [];
  const original = { activate: (...args) => forwarded.push(args), hover: () => {} };
  const launch = (...args) => { launched.push(args); return { once() {}, unref() {} }; };
  return { launched, forwarded, original, launch, handler: quotaLinkHandler(original, launch) };
}

test('Tabby 点击三角直接分发给本地额度控制器，不需要修饰键', () => {
  const h = fixture(); let prevented = 0;
  const event = { button: 0, preventDefault() { prevented++; }, stopPropagation() {} };
  assert.equal(h.handler.allowNonHttpProtocols, true);
  h.handler.activate(event, 'claude-quota://toggle/test-session');
  assert.equal(h.launched.length, 1); assert.equal(prevented, 1); assert.equal(h.forwarded.length, 0);
  const [node, args, options] = h.launched[0];
  assert.equal(node, process.env.CLAUDE_STATUSLINE_NODE || 'node');
  assert.deepEqual(args, [path.join(configDir, 'statusline-accounts.js'), '--handle-uri', 'claude-quota://toggle/test-session']);
  assert.equal(options.stdio, 'ignore'); assert.equal(options.shell, undefined);
  assert.equal(options.env.CLAUDE_CONFIG_DIR, configDir);
});

test('仅允许状态栏精确格式，拒绝其它协议、编码和路径折叠', () => {
  const h = fixture();
  for (const uri of ['claude-quota://toggle/../bad', 'claude-quota://toggle/%2ebad', 'claude-quota://toggle/id?x=1',
    'claude-quota://other/id', 'javascript:alert(1)', 'file://server/share', 'unknown://test', 'not a url']) h.handler.activate({}, uri);
  h.handler.activate({ button: 2 }, 'claude-quota://toggle/id');
  assert.equal(h.launched.length, 0); assert.equal(h.forwarded.length, 0);
});

test('普通 HTTP 链接继续交给 Tabby 原处理器', () => {
  const h = fixture(), event = { ctrlKey: true };
  h.handler.activate(event, 'https://example.test/path');
  h.handler.activate(event, 'http://127.0.0.1:1234/');
  assert.equal(h.forwarded.length, 2); assert.equal(h.launched.length, 0);
  assert.equal(h.handler.hover, h.original.hover);
});

test('插件安装到本地终端，兼容内置插件加载顺序；卸载时恢复处理器', async () => {
  const h = fixture(); let decoratorClass, disposed = 0;
  class TerminalDecorator { detach() {} }
  class XTermFrontend { constructor() { this.xterm = { options: { linkHandler: h.original },
    registerLinkProvider() { return { dispose() { disposed++; } }; } }; } }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(root + '/index.js', 'utf8'), {
    module, exports: module.exports,
    require(name) {
      if (name === '@angular/core') return { Injectable: () => () => {}, NgModule: options => () => { decoratorClass = options.providers[0].useClass; } };
      if (name === 'tabby-core') return { ConfigService: class {}, PlatformService: class {} };
      if (name === 'tabby-terminal') return { TerminalDecorator, XTermFrontend };
      if (name === './paths') return { findPathLinks: async () => [] };
      if (name === './claude-quota') return { quotaLinkHandler: original => quotaLinkHandler(original, h.launch) };
      throw Error(name);
    }, console, queueMicrotask,
  });
  const decorator = new decoratorClass({ store: { clickableLinks: {} } }, {});
  const remote = { profile: { type: 'ssh' }, frontend: new XTermFrontend() };
  decorator.attach(remote); assert.equal(remote.frontend.xterm.options.linkHandler, h.original);
  const local = { profile: { type: 'local' }, frontend: new XTermFrontend() };
  decorator.attach(local);
  // 模拟内置链接装饰器在用户插件之后才挂载。
  const lateOriginal = { ...h.original };
  local.frontend.xterm.options.linkHandler = lateOriginal;
  await Promise.resolve();
  assert.equal(local.frontend.xterm.options.linkHandler.allowNonHttpProtocols, true);
  local.frontend.xterm.options.linkHandler.activate({ button: 0 }, 'claude-quota://toggle/local-session');
  assert.equal(h.launched.length, 1);
  decorator.detach(local); assert.equal(local.frontend.xterm.options.linkHandler, lateOriginal); assert.equal(disposed, 1);
});
