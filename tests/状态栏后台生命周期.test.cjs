'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('网络超过 2 秒时渲染仍立即退出，重复重绘不会终止后台刷新', async () => {
 const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'后台生命周期-'));
 const calls={fleet:0,detail:0,route:0};let server;
 try {
  const slot={id:'slow',name:'慢接口虚拟机',platform:'anthropic',has_token:true,account_uuid:'account',
   utilization_5h:0.45,utilization_7d:0.23,reset_5h:Date.now()+3600000,reset_7d:Date.now()+86400000};
  server=http.createServer(async(req,res)=>{
   req.resume();res.setHeader('content-type','application/json');let body;
   if(req.url==='/api/panel/login')body={ok:true,token:'fixture',expires_in:3600};
   else if(req.url==='/api/panel/vms'){calls.fleet++;await pause(2700);body={ok:true,data:{items:[slot]}};}
   else if(req.url==='/api/panel/vms/slow'){calls.detail++;body={ok:true,data:{vm:slot,account:{account_id:'account'}}};}
   else if(req.url.startsWith('/api/panel/usage-logs?')){calls.route++;body={ok:true,data:{logs:[{clientSessionId:'slow-session',statusCode:200,vmId:'slow',accountId:'account',createdAt:new Date().toISOString()}]}};}
   else{res.writeHead(404);res.end('{}');return;}
   res.end(JSON.stringify(body));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`,credentials=path.join(root,'模拟登录.json');
  fs.writeFileSync(credentials,JSON.stringify({'管理页面':origin,'用户名':'fixture','密码':'fixture'}));
  fs.writeFileSync(path.join(root,'local-statusline-quota-config.json'),JSON.stringify({base_url:origin,vm_id:'slow',credentials_file:credentials}));
  const render=async()=>{
   const started=Date.now(),child=spawn(process.execPath,[path.join(__dirname, '../src/local-statusline.js')],{env:{...process.env,CLAUDE_CONFIG_DIR:root},stdio:['pipe','pipe','pipe']});
   let output='';child.stdout.on('data',x=>output+=x);child.stdin.end(JSON.stringify({session_id:'slow-session',cost:{total_api_duration_ms:1}}));
   const cancel=setTimeout(()=>child.kill('SIGTERM'),1900);
   const [code,signal]=await once(child,'close');clearTimeout(cancel);
   assert.equal(signal,null,'宿主下一次重绘前必须退出');assert.equal(code,0);assert(Date.now()-started<1000,'渲染不得等待慢网络');return output;
  };
  const first=await render();assert.match(first,/账户待确认/);
  await pause(1000);await render();await pause(1000);await render();
  const deadline=Date.now()+4000;
  while(true){
   let fleet;try{fleet=JSON.parse(fs.readFileSync(path.join(root,'cache/statusline-accounts/fleet.json')))}catch{}
   if(fleet?.data?.length&&fleet._loading!==true)break;
   assert(Date.now()<deadline,'后台请求在渲染退出后仍须完成');await pause(50);
  }
  const ready=await render();assert.match(ready,/慢接口虚拟机 5h/);assert.match(ready,/45%/);
  assert.deepEqual(calls,{fleet:1,detail:1,route:1});
  assert(!fs.existsSync(path.join(root,'cache/statusline-accounts/refresh.lock')));
 }finally{
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  fs.rmSync(root,{recursive:true,force:true});
 }
});
