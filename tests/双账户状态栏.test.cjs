'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { strWidth, wrap } = require(path.join(__dirname, '../src/local-statusline.js'));
const { queryQuota, querySessionRoute, queryFleet, readConfig } = require(path.join(__dirname, '../src/vm2api-quota.js'));
const strip = text => text.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;]*m/g, '');
const script = path.join(__dirname, '../src/local-statusline.js');
const controller = path.join(__dirname, '../src/statusline-accounts.js');

function command(args, env, input = '') {
  const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', x => { out += x; }); child.stderr.on('data', x => { err += x; });
  child.stdin.end(input);
  return once(child, 'close').then(([code]) => ({ code, out, err, text: strip(out) }));
}

test('实际会话归属、双账户、并发缓存、故障与交互完整验证', async () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), '状态栏验证-'));
  const counts = { login: 0, fleet: 0, details: 0, route: 0 };
  let routes = { s1: 'a', s2: 'b' }, routeFailure = false, wrongSession = false, detailFailure = false;
  let accountA = 'account-a';
  const slot = id => ({ id, name: id === 'a' ? '虚拟机一' : '虚拟机二', platform: 'anthropic',
    has_token: true, account_uuid: id === 'a' ? accountA : 'account-b',
    utilization_5h: id === 'a' ? 0.31 : 0.72, utilization_7d: id === 'a' ? 0.88 : 0.09,
    reset_5h: new Date(Date.now() + 3600000).toISOString(), reset_7d: new Date(Date.now() + 86400000).toISOString(),
    estimate_5h: { status: 'ok', spent_usd: 13, total_usd: 40 }, estimate_7d: { status: 'ok', spent_usd: 30, total_usd: 200 } });
  const server = http.createServer(async (req, res) => {
    req.resume();
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('content-type', 'application/json');
    const send = body => res.end(JSON.stringify(body));
    if (url.pathname === '/api/panel/login') { counts.login++; return send({ ok: true, token: 'fixture-only', expires_in: 3600 }); }
    if (url.pathname === '/api/panel/vms') {
      counts.fleet++; await new Promise(resolve => setTimeout(resolve, 100));
      return send({ ok: true, data: { items: [slot('a'), slot('b')] } });
    }
    if (url.pathname.startsWith('/api/panel/vms/')) {
      counts.details++;
      if (detailFailure) { res.statusCode = 503; return send({ ok: false }); }
      const vm = slot(url.pathname.split('/').pop()); return send({ ok: true, data: { vm, account: { account_id: vm.account_uuid } } });
    }
    if (url.pathname === '/api/panel/usage-logs') {
      counts.route++;
      if (routeFailure) { res.statusCode = 503; return send({ ok: false }); }
      const sid = url.searchParams.get('session_id'), id = routes[sid];
      return send({ ok: true, data: { logs: id ? [{ clientSessionId: wrongSession ? 'other' : sid,
        sessionId: 'outbound-different-id', vmId: id, accountId: id === 'a' ? 'account-a' : 'account-b',
        statusCode: 200, createdAt: new Date().toISOString(), requestId: 'fixture-request' }] : [] } });
    }
    res.statusCode = 404; send({ ok: false });
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const credentialsFile = path.join(root, '模拟登录.json');
    fs.writeFileSync(credentialsFile, JSON.stringify({ '用户名': 'fixture', '密码': 'fixture', '管理页面': origin }));
    fs.writeFileSync(path.join(root, 'local-statusline-quota-config.json'), JSON.stringify({ base_url: origin, vm_id: 'a', credentials_file: credentialsFile }));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: root, COLUMNS: '220' };
    const renderRaw = (sid, marker = 1, columns = 220) => command([script], { ...env, COLUMNS: String(columns) }, JSON.stringify({
      session_id: sid, cost: { total_api_duration_ms: marker }, context_window: { current_usage: { input_tokens: 50000 }, context_window_size: 200000 },
    }));
    // 宿主每 2 秒重绘会取消仍运行的脚本；网络刷新必须在渲染退出后独立完成。
    const render = async (sid, marker = 1, columns = 220) => {
      await renderRaw(sid, marker, columns);
      const deadline = Date.now() + 5000;
      let ticks = 0;
      while (true) {
        let route, fleet;
        try { route = JSON.parse(fs.readFileSync(path.join(root, `cache/statusline-accounts/route-${sid}.json`))); } catch (_) {}
        try { fleet = JSON.parse(fs.readFileSync(path.join(root, 'cache/statusline-accounts/fleet.json'))); } catch (_) {}
        if (route?._marker === String(marker) && route._loading !== true && fleet?._loading !== true) break;
        if (Date.now() > deadline) throw Error('等待独立后台刷新超时');
        // 模拟宿主持续重绘：上一后台刚写完缓存但尚未释放锁时，下一次重绘会接续新会话。
        if (++ticks % 5 === 0) await renderRaw(sid, marker, columns);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return renderRaw(sid, marker, columns);
    };
    const initial = await Promise.all(Array.from({ length: 6 }, () => render('s1')));
    initial.forEach(r => { assert.equal(r.code, 0); assert.match(r.text, /虚拟机一 5h 31%/); assert.match(r.text, /7d 88%/); });
    assert.deepEqual(counts, { login: 1, fleet: 1, details: 2, route: 1 });
    console.log('通过：六进程冷启动去重，当前会话匹配账户一，后台完成后下一次渲染显示新额度。');
    await render('s1'); assert.equal(counts.route, 1);
    let result = await render('s2'); assert.match(result.text, /虚拟机二 5h 72%/); assert.equal(counts.fleet, 1);
    console.log('通过：不同会话选不同账户；共享额度缓存，路由独立。');
    routes.s1 = 'b'; result = await render('s1', 2);
    assert.match(result.text, /虚拟机二 5h 72%/); assert.equal(counts.route, 3);
    console.log('通过：新响应标记改变后立即重新匹配，30 秒缓存不掩盖账户切换。');
    result = await render('missing'); assert.match(result.text, /账户待确认 5h --/); assert(!result.text.includes('虚拟机一 5h'));
    wrongSession = true; result = await render('s1', 3); assert.match(result.text, /账户待确认/); wrongSession = false;
    routeFailure = true; result = await render('s2', 2); assert.match(result.text, /账户待确认/); routeFailure = false;
    console.log('通过：未知会话、返回其它会话及路由接口失败均显示待确认，不拿固定槽或旧路由顶替。');
    let toggled = await command([controller, '--handle-uri', 'claude-quota://toggle/s1'], env); assert.equal(toggled.code, 0);
    result = await render('s1', 4); assert.match(result.text, /○ 虚拟机一 5h 31%/); assert.match(result.text, /▾ 虚拟机二 5h/); assert.equal((result.text.match(/虚拟机二 5h/g) || []).length, 1); assert(!/全部额度|收起额度/.test(result.text));
    assert(!strip((await render('s2', 3)).out).includes('○ 虚拟机一'));
    const narrow = await render('s1', 4, 70);
    for (const line of narrow.out.split('\n')) assert(strWidth(line) <= 66, `换行宽度 ${strWidth(line)}`);
    await command([controller, '--handle-uri', 'claude-quota://toggle/s1'], env);
    result = await render('s1', 4); assert(!result.text.includes('○ 虚拟机一')); assert.match(result.text, /▸ 虚拟机二 5h/);
    assert.equal((await command([controller, '--handle-uri', 'claude-quota://toggle/../unsafe'], env)).code, 1);
    console.log('通过：展开只追加其余虚拟机，当前虚拟机仅出现一次，收起、会话隔离、窄终端换行与非法链接校验。');
    const cachePath = path.join(root, 'cache/statusline-accounts/fleet.json');
    const fleet = JSON.parse(fs.readFileSync(cachePath)); fleet._tried = 0; fs.writeFileSync(cachePath, JSON.stringify(fleet));
    accountA = 'replacement-a'; routes.s1 = 'a'; result = await render('s1', 5); assert.match(result.text, /账户待确认/);
    console.log('通过：虚拟机重新绑定账户后，不把原账户请求匹配到新账户额度。');
    const config = readConfig(root);
    const legacy = await queryQuota({ config, sessionFile: path.join(root, 'cache/local-statusline-vm2api-session.json'), signal: AbortSignal.timeout(3000) });
    assert.equal(legacy.vm_id, 'a'); assert.equal(legacy.account_id, 'replacement-a');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'cache/local-statusline-quota.json')))._source, config.source);
    console.log('通过：原单账户查询接口和保活插件的旧缓存契约仍可用。');
    const old = JSON.parse(fs.readFileSync(cachePath)); old._ts = Date.now() - 601000; old._tried = Date.now(); fs.writeFileSync(cachePath, JSON.stringify(old));
    result = await render('s1', 5); assert.match(result.text, /账户待确认 5h --/);
    assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(root, 'cache/statusline-accounts/refresh.lock')), false);
    console.log('通过：过期缓存不显示，缓存为 0600，刷新锁正常释放。');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('超链接按可见文字计算宽度，名称不会注入终端控制符', () => {
  const { cleanLabel, toggleLink } = require(path.join(__dirname, '../src/statusline-accounts.js'));
  const link = toggleLink('test', false);
  assert.equal(strWidth(link), 1);
  assert.equal(wrap(['123', link], 20).length, 1);
  assert.equal(cleanLabel('账户\n\x1b\x07\x9b'), '账户');
  assert.equal(toggleLink('../bad', false), '');
});

test('路由精确核对入站会话，忽略失败请求与出站会话误命中', async () => {
  const row = { clientSessionId: 'local', sessionId: 'upstream', statusCode: 200, vmId: 'b', accountId: 'account-b', requestId: 'chosen', createdAt: '2026-10-28T11:00:00Z' };
  const request = async () => ({ data: { logs: [{ ...row, clientSessionId: 'other', sessionId: 'local' },
    { ...row, statusCode: 500 }, row] } });
  assert.equal((await querySessionRoute(request, 'local')).request_id, 'chosen');
  const fleet = await queryFleet(async endpoint => endpoint === '/api/panel/vms'
    ? { data: { items: [{ id: 'a', name: '一', platform: 'anthropic', has_token: true, account_uuid: 'old' }] } }
    : { data: { vm: { id: 'a', has_token: true, account_uuid: 'new' }, account: { account_id: 'new' } } });
  assert.equal(fleet[0].unavailable, true);
  assert.equal(fleet[0].account_id, 'old');
});
