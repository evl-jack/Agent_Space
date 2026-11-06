import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.mjs';
import { Team } from '../server/team.mjs';
import { createWorkspace } from '../server/main.mjs';
import { resolveProjectPath, readProjectFile, listProjectFiles, githubRepo, profileDefinitions, inside } from '../server/policy.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function fixture(){
  const folder=path.join(root,'.local','tests',randomUUID());const project=path.join(folder,'project');const other=path.join(folder,'other');
  await fs.mkdir(project,{recursive:true});await fs.mkdir(other);await fs.writeFile(path.join(project,'readme.txt'),'project evidence');await fs.writeFile(path.join(other,'secret.txt'),'outside sentinel');
  const store=await new Store(path.join(folder,'data')).open();const p=await store.addProject({name:'One',root:project});return {folder,project,other,store,p};
}
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Expected state did not arrive.');}

test('file access accepts an in-project file and rejects traversal, absolute paths, metadata, and streams',async()=>{
  const f=await fixture();assert.equal(await readProjectFile(f.project,'readme.txt'),'project evidence');
  for(const value of ['../other/secret.txt',f.other,'.git/config','.git /config','.git./config','.local/state.json','.codex/config.toml','readme.txt:stream','sub/../../secret.txt','NUL.txt'])await assert.rejects(()=>resolveProjectPath(f.project,value,{write:true}));
  assert.equal(inside(f.project,`${f.project}-other`),false);
});
test('directory listing omits credential and protected directories',async()=>{
  const f=await fixture();await fs.mkdir(path.join(f.project,'.git'));await fs.mkdir(path.join(f.project,'.local'));await fs.writeFile(path.join(f.project,'.env'),'SYNTHETIC=1');
  assert.deepEqual((await listProjectFiles(f.project)).map(v=>v.name),['readme.txt']);
});
test('linked directories cannot escape the approved folder',async t=>{
  const f=await fixture();try{await fs.symlink(f.other,path.join(f.project,'linked'),process.platform==='win32'?'junction':'dir');}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('This test account cannot create links.');return;}throw e;}
  await assert.rejects(()=>readProjectFile(f.project,'linked/secret.txt'),/Linked paths/);
});
test('repository URLs cannot embed credentials or unrelated services',()=>{
  assert.equal(githubRepo('https://github.com/example/repo.git'),'https://github.com/example/repo');
  for(const value of ['https://example.com/repo','https://token@github.com/example/repo','https://github.com/example/repo/tree/main'])assert.throws(()=>githubRepo(value));
});
test('profiles deny broad reads, protect application data, and disable command network access',()=>{
  const p={root:path.join(root,'synthetic-project')};const profiles=profileDefinitions(p,[path.dirname(process.execPath)]);
  assert.equal(profiles.space_read.filesystem[':root'],'deny');assert.equal(profiles.space_read.filesystem[path.join(p.root,'.local')],'deny');
  assert.equal(profiles.space_execute.filesystem[p.root],'write');assert.equal(profiles.space_execute.filesystem[path.join(p.root,'.git')],'deny');assert.equal(profiles.space_execute.network.enabled,false);
});
test('projects retain separate briefs and activity records',async()=>{
  const f=await fixture();const p2=await f.store.addProject({name:'Two',root:f.other});f.p.brief='first only';p2.brief='second only';
  f.store.event(f.p.id,'lead','test','FIRST');f.store.event(p2.id,'reporter','test','SECOND');await f.store.save();
  const reopened=await new Store(f.store.folder).open();assert.equal(reopened.project(f.p.id).brief,'first only');assert.deepEqual(reopened.data.events.filter(e=>e.projectId===f.p.id).map(e=>e.text),['FIRST']);
});
test('live tasks default to paused and users cannot directly address Runner',async()=>{
  const f=await fixture();const team=new Team(f.store,()=>{});assert.throws(()=>team.start(f.p.id,'lead','Hi'),/paused/);team.liveEnabled=true;assert.throws(()=>team.start(f.p.id,'runner','Hi'),/Lead directs/);
});
test('Reporter and Lead cannot use Runner action tools',async()=>{
  const f=await fixture();const team=new Team(f.store,()=>{});const run={project:f.p,task:{id:randomUUID()}};
  await assert.rejects(()=>team.executeTool(run,{},'reporter','write_project_file',{path:'a.txt',content:'bad'}),/read-only/);
  await assert.rejects(()=>team.executeTool(run,{},'lead','write_project_file',{path:'a.txt',content:'bad'}),/role/);
  assert.equal(await team.executeTool(run,{},'reporter','read_project_file',{path:'readme.txt'}),'project evidence');
});

class FakeClient extends EventEmitter{
  constructor(record,{hang=false}={}){super();this.record=record;this.hang=hang;this.threads=new Map();this.turn=0;this.closed=false;this.tools=new Map();}
  async open(){return this;}
  async request(method,p){
    this.record.push({method,p});
    if(method==='config/read')return {config:{mcp_servers:{external:{url:'https://invalid.example'}},plugins:{external:{enabled:true}}}};
    if(method==='thread/start'||method==='thread/fork'){if(p.ephemeral&&p.deferGoalContinuation)throw new Error('`deferGoalContinuation` cannot be combined with `ephemeral`');const id=randomUUID();const role=/You are the (lead|runner|reporter)/.exec(p.baseInstructions)[1];this.threads.set(id,role);return {thread:{id}};}
    if(method==='turn/start'){
      const id=randomUUID();const role=this.threads.get(p.threadId);const count=++this.turn;
      if(!this.hang)setTimeout(()=>{
        if(role==='runner'){const toolId=randomUUID();this.tools.set(toolId,{threadId:p.threadId,turnId:id});this.emit('request',{id:toolId,method:'item/tool/call',params:{threadId:p.threadId,turnId:id,tool:'write_project_file',arguments:{path:'runner.txt',content:'written by scoped runner'},callId:toolId}});}
        else{const text=role==='reporter'?'The project evidence is available.':JSON.stringify(count===1?{message:'I will ask Runner to write the file.',runnerTask:'Write runner.txt.'}:{message:'Runner completed the scoped file change.',runnerTask:null});this.complete(p.threadId,id,text);}
      },2);
      return {turn:{id}};
    }
    if(method==='command/exec')return {exitCode:0,stdout:'verified',stderr:''};
    throw new Error(`Unexpected fake call ${method}`);
  }
  complete(threadId,turnId,text){this.emit('notification','item/completed',{threadId,turnId,item:{id:randomUUID(),type:'agentMessage',phase:'final_answer',text}});this.emit('notification','turn/completed',{threadId,turn:{id:turnId,status:'completed'}});}
  respond(id,result){const turn=this.tools.get(id);if(turn){this.record.push({toolResult:result});this.complete(turn.threadId,turn.turnId,'Created runner.txt through the scoped tool.');}}
  async close(){if(this.closed)return;this.closed=true;this.emit('closed',new Error('Closed'));}
}
test('Lead delegates to Runner, reviews its result, and does not receive another project’s activity',async()=>{
  const f=await fixture();const second=await f.store.addProject({name:'Two',root:f.other});f.store.event(second.id,'lead','note','OTHER_PROJECT_SENTINEL');
  f.p.efforts={lead:'max',runner:'medium',reporter:'low'};
  const calls=[];const team=new Team(f.store,()=>{},{runtimeRoots:[],clientFactory:()=>new FakeClient(calls)});team.liveEnabled=true;
  const task=team.start(f.p.id,'lead','Write a scoped file.');await until(()=>!team.running.size);
  assert.equal(task.status,'completed');assert.equal(task.delegations,1);assert.equal(await fs.readFile(path.join(f.project,'runner.txt'),'utf8'),'written by scoped runner');
  assert.equal(calls.filter(c=>c.method==='turn/start').length,3);assert.equal(JSON.stringify(calls).includes('OTHER_PROJECT_SENTINEL'),false);
  assert.deepEqual(calls.filter(c=>c.method==='turn/start').map(c=>c.p.effort),['max','medium','max']);
  const starts=calls.filter(c=>c.method==='thread/start');assert.equal(starts[0].p.config.mcp_servers.external.enabled,false);assert.equal(starts[0].p.config.features.apps,false);assert.equal(starts[0].p.permissions,'space_read');assert.equal(starts[1].p.permissions,'space_execute');assert.ok(starts[1].p.dynamicTools.some(t=>t.name==='write_project_file'));assert.ok(starts[1].p.dynamicTools.find(t=>t.name==='run_project_command').inputSchema.properties.cwd);
});
test('Reporter only runs on request and never starts a Runner',async()=>{
  const f=await fixture();const calls=[];const team=new Team(f.store,()=>{},{runtimeRoots:[],clientFactory:()=>new FakeClient(calls)});team.liveEnabled=true;
  f.p.efforts.reporter='high';
  assert.equal(calls.length,0);const task=team.start(f.p.id,'reporter','Summarize current evidence.');await until(()=>!team.running.size);assert.equal(task.status,'completed');assert.equal(calls.filter(c=>c.method==='thread/start').length,1);assert.equal(f.store.data.messages.filter(m=>m.role==='reporter').length,1);
  assert.equal(calls.find(c=>c.method==='turn/start').p.effort,'high');
});
test('native fork is temporary, omits incompatible goal deferral, and disables automatic goals',async()=>{
  const f=await fixture();f.p.sourceMode='fork';f.p.sourceThreadId='synthetic-source';const calls=[];
  const team=new Team(f.store,()=>{},{runtimeRoots:[],clientFactory:()=>new FakeClient(calls)});team.liveEnabled=true;team.start(f.p.id,'lead','Continue');await until(()=>!team.running.size);
  const fork=calls.find(c=>c.method==='thread/fork');assert.equal(fork.p.ephemeral,true);assert.equal(fork.p.deferGoalContinuation,undefined);assert.equal(fork.p.config.features.goals,false);assert.equal(fork.p.permissions,'space_read');assert.equal(fork.p.cwd,f.project);
});
test('Stop closes every owned client and finishes the task without a retry',async()=>{
  const f=await fixture();const calls=[];const clients=[];const team=new Team(f.store,()=>{},{runtimeRoots:[],clientFactory:()=>{const c=new FakeClient(calls,{hang:true});clients.push(c);return c;}});team.liveEnabled=true;
  const task=team.start(f.p.id,'lead','Wait');await until(()=>calls.some(c=>c.method==='turn/start'));await team.stop(task.id);await until(()=>!team.running.size);assert.equal(task.status,'stopped');assert.equal(clients.every(c=>c.closed),true);assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
});

async function appFixture(t){
  const f=await fixture();const app=await createWorkspace({root,dataDir:path.join(f.folder,'http'),port:0,inspect:async()=>({connected:true,plan:'test',models:[{id:'test-model',name:'Test model',efforts:['low','medium','high']}]})});t.after(()=>app.close());
  const session=await fetch(`${app.origin}/api/session`,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({token:app.token})});const cookie=session.headers.get('set-cookie').split(';')[0];
  const headers={Cookie:cookie,Origin:app.origin,'X-Agent-Space-Token':app.token,'Content-Type':'application/json'};
  const call=async(url,method='GET',input,extra={})=>fetch(`${app.origin}${url}`,{method,headers:{...headers,...extra},...(input?{body:JSON.stringify(input)}:{})});return {...f,app,call,headers};
}
test('HTTP API rejects unauthenticated, cross-origin, missing-token, and rebound-host requests',async t=>{
  const f=await appFixture(t);assert.equal((await fetch(`${f.app.origin}/api/state`)).status,401);
  assert.equal((await f.call('/api/projects','POST',{name:'Denied',root:f.project},{Origin:'https://untrusted.invalid'})).status,401);
  assert.equal((await f.call('/api/live','POST',{enabled:true},{'X-Agent-Space-Token':''})).status,401);
  const rebound=await new Promise((resolve,reject)=>{const url=new URL(f.app.origin);const request=http.request({hostname:'127.0.0.1',port:url.port,path:'/api/state',headers:{...f.headers,Host:'untrusted.invalid'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end();});
  assert.equal(rebound,403);
  assert.equal((await f.call('/api/state')).status,200);
  assert.equal((await (await f.call('/api/session')).json()).csrf,f.app.token);
});
test('connection discovery never enables live work and task submission is blocked while paused',async t=>{
  const f=await appFixture(t);const created=await (await f.call('/api/projects','POST',{name:'HTTP project',root:f.project})).json();
  assert.equal((await f.call('/api/connection','POST')).status,200);assert.equal(f.app.team.liveEnabled,false);
  assert.equal((await f.call('/api/tasks','POST',{projectId:created.id,role:'lead',prompt:'Do not run'})).status,400);assert.equal(f.app.store.data.tasks.length,0);
});
test('invalid settings do not partially mutate a project',async t=>{
  const f=await appFixture(t);const p=await f.app.store.addProject({name:'Before',root:f.project});
  assert.equal((await f.call(`/api/projects/${p.id}`,'PATCH',{name:'After',repository:'https://untrusted.invalid'})).status,400);assert.equal(p.name,'Before');
});
test('performance is saved per role and unsupported effort is rejected without partial changes',async t=>{
  const f=await appFixture(t);const p=await f.app.store.addProject({name:'Performance',root:f.project});await f.call('/api/connection','POST');
  const models={lead:'test-model',runner:'test-model',reporter:'test-model'};const efforts={lead:'high',runner:'medium',reporter:'low'};
  assert.equal((await f.call(`/api/projects/${p.id}`,'PATCH',{models,efforts})).status,200);assert.deepEqual(p.efforts,efforts);
  assert.equal((await f.call(`/api/projects/${p.id}`,'PATCH',{name:'Rejected',efforts:{reporter:'ultra'}})).status,400);assert.equal(p.name,'Performance');assert.equal(p.efforts.reporter,'low');
  const reopened=await new Store(f.app.store.folder).open();assert.deepEqual(reopened.project(p.id).efforts,efforts);
});
test('file checkpoint restore preserves newer edits and can restore the matching saved version',async t=>{
  const f=await appFixture(t);const p=await f.app.store.addProject({name:'Recovery',root:f.project});
  const taskId=randomUUID();const run={project:p,task:{id:taskId}};
  const result=await f.app.team.executeTool(run,{},'runner','write_project_file',{path:'readme.txt',content:'runner version'});
  await fs.writeFile(path.join(f.project,'readme.txt'),'newer user version');assert.equal((await f.call('/api/restore','POST',{projectId:p.id,backupId:result.backupId})).status,400);
  assert.equal(await fs.readFile(path.join(f.project,'readme.txt'),'utf8'),'newer user version');
  await fs.writeFile(path.join(f.project,'readme.txt'),'runner version');assert.equal((await f.call('/api/restore','POST',{projectId:p.id,backupId:result.backupId})).status,200);assert.equal(await fs.readFile(path.join(f.project,'readme.txt'),'utf8'),'project evidence');
});


test('computer mode permits absolute paths and preserves role restrictions and network isolation',async()=>{
  const f=await fixture();const team=new Team(f.store,()=>{});const run={project:{...f.p,computerAccess:true},task:{id:randomUUID()}};
  const target=path.join(f.other,'from-runner.txt');
  await team.executeTool(run,{},'runner','write_project_file',{path:target,content:'synthetic cross-folder file'});
  assert.equal(await team.executeTool(run,{},'reporter','read_project_file',{path:target}),'synthetic cross-folder file');
  await assert.rejects(()=>team.executeTool(run,{},'reporter','write_project_file',{path:target,content:'bad'}),/read-only/);
  await assert.rejects(()=>team.executeTool(run,{},'lead','write_project_file',{path:target,content:'bad'}),/role/);
  const profiles=profileDefinitions(run.project);
  assert.equal(profiles.space_read.filesystem[':root'],'read');assert.equal(profiles.space_execute.filesystem[':root'],'write');assert.equal(profiles.space_execute.network.enabled,false);
  const reopened=await new Store(f.store.folder).open();assert.equal(reopened.data.settings.folderMode,'approved');
});

test('paused limits allow continued delegation and usage accounting without a task timer',async()=>{
  const f=await fixture();f.store.data.settings={folderMode:'computer',taskLimitsEnabled:false};f.p.limits={minutes:0,tokens:1,delegations:0};
  const calls=[];const team=new Team(f.store,()=>{},{runtimeRoots:[],clientFactory:()=>new FakeClient(calls)});team.liveEnabled=true;
  let assignments=0;
  team.turn=async(run,client,threadId,role)=>{
    assert.equal(run.timer,undefined);assert.equal(run.project.computerAccess,true);
    team.notification(run,client,'thread/tokenUsage/updated',{threadId,turnId:randomUUID(),tokenUsage:{last:{totalTokens:50000}}});
    await new Promise(resolve=>setTimeout(resolve,3));assert.equal(run.stopped,false);
    return role==='lead'?JSON.stringify({message:'Next step',runnerTask:assignments++<5?'Do next step':null}):'Step complete';
  };
  const task=team.start(f.p.id,'lead','Synthetic test');await until(()=>!team.running.size);
  assert.equal(task.status,'completed');assert.equal(task.delegations,5);assert.ok(task.tokens>1);
  await f.store.save();assert.equal((await new Store(f.store.folder).open()).data.settings.taskLimitsEnabled,false);
});


test('computer access settings need explicit consent and cross-folder checkpoints restore safely',async t=>{
  const f=await appFixture(t);const p=await f.app.store.addProject({name:'Controls',root:f.project});const controls={folderMode:'computer',taskLimitsEnabled:false};
  assert.equal((await f.call('/api/projects/'+p.id,'PATCH',{controls})).status,400);
  assert.equal(f.app.store.data.settings.folderMode,'approved');
  assert.equal((await f.call('/api/projects/'+p.id,'PATCH',{controls:{...controls,userApproved:true}})).status,200);
  assert.deepEqual(f.app.store.data.settings,controls);assert.equal(f.app.team.liveEnabled,false);
  const run={project:{...p,computerAccess:true},task:{id:randomUUID()}};const target=path.join(f.other,'secret.txt');
  const result=await f.app.team.executeTool(run,{},'runner','write_project_file',{path:target,content:'replacement'});
  assert.equal((await f.call('/api/restore','POST',{projectId:p.id,backupId:result.backupId})).status,200);
  assert.equal(await fs.readFile(target,'utf8'),'outside sentinel');
  assert.equal((await f.call('/api/projects/'+p.id,'PATCH',{controls:{folderMode:'approved',taskLimitsEnabled:true}})).status,200);
  await assert.rejects(()=>f.app.team.executeTool({project:p,task:{id:randomUUID()}},{},'reporter','read_project_file',{path:target}),/relative/);
});


test('Runner commands use the requested subfolder and approved mode rejects escaping cwd',async()=>{
 const f=await fixture();await fs.mkdir(path.join(f.project,'Solver'));const calls=[];const team=new Team(f.store,()=>{},{runtimeRoots:[],clientFactory:()=>new FakeClient(calls)});
 const run={project:f.p,task:{id:randomUUID()},clients:new Set(),stopped:false};
 try{await team.executeTool(run,{},'runner','run_project_command',{command:['synthetic-check'],cwd:'Solver'});assert.equal(calls.find(c=>c.method==='command/exec').p.cwd,path.join(f.project,'Solver'));
 await assert.rejects(()=>team.executeTool(run,{},'runner','run_project_command',{command:['synthetic-check'],cwd:'../other'}),/outside/);}finally{for(const c of run.clients)await c.close();}
});

test('Reporter publishing is gated by the actual user request and offered only for explicit publishing',async()=>{
 const f=await fixture();const team=new Team(f.store,()=>{});const calls=[];const client=new FakeClient(calls);
 const run={project:f.p,task:{id:randomUUID(),prompt:'Summarize the project'},threads:new Map(),allowPublish:false};
 await assert.rejects(()=>team.executeTool(run,{},'reporter','publish_project_files',{paths:['readme.txt'],message:'Update'}),/explicit/);
 await team.newThread(run,client,'reporter');assert.equal(calls.at(-1).p.dynamicTools.some(t=>t.name==='publish_project_files'),false);
 run.allowPublish=true;run.task.prompt='Publish to GitHub: readme.txt';await team.newThread(run,client,'reporter');assert.equal(calls.at(-1).p.permissions,'space_read');assert.ok(calls.at(-1).p.dynamicTools.some(t=>t.name==='publish_project_files'));
 let publishes=0;team.publisher.publish=async()=>{publishes++;return {published:true,url:'https://github.com/example/repo/commit/test'};};
 await team.executeTool(run,{},'reporter','publish_project_files',{paths:['readme.txt'],message:'Update'});await team.executeTool(run,{},'reporter','publish_project_files',{paths:['readme.txt'],message:'Update'});assert.equal(publishes,1);
});


test('preview route requires authentication and serves passive graph bytes',async t=>{
 const f=await appFixture(t);const p=await f.app.store.addProject({name:'Preview',root:f.project});await fs.writeFile(path.join(f.project,'graph.svg'),'<svg xmlns="http://www.w3.org/2000/svg"></svg>');
 const url='/api/preview?'+new URLSearchParams({projectId:p.id,path:'graph.svg'});
 assert.equal((await fetch(f.app.origin+url)).status,401);const r=await f.call(url);assert.equal(r.status,200);assert.equal(r.headers.get('X-Preview-Kind'),'image');assert.match(r.headers.get('Content-Security-Policy'),/sandbox/);assert.match(await r.text(),/<svg/);
 assert.equal((await f.call('/preview.js')).status,200);
});


test('Runner creates new files and parent directories without overwriting existing files',async()=>{
 const f=await fixture();const team=new Team(f.store,()=>{});const run={project:f.p,task:{id:randomUUID()}};
 const result=await team.executeTool(run,{},'runner','create_project_file',{path:'new-folder/created.py',content:'print("created")'});
 assert.equal(result.created,true);assert.equal(await fs.readFile(path.join(f.project,'new-folder/created.py'),'utf8'),'print("created")');
 await assert.rejects(()=>team.executeTool(run,{},'runner','create_project_file',{path:'new-folder/created.py',content:'replace'}),/already exists/);
 assert.equal(await fs.readFile(path.join(f.project,'new-folder/created.py'),'utf8'),'print("created")');
 await assert.rejects(()=>team.executeTool(run,{},'reporter','create_project_file',{path:'not-allowed.txt',content:'blocked'}),/read-only/);
 await assert.rejects(()=>team.executeTool(run,{},'runner','create_project_file',{path:'../other/not-allowed.txt',content:'blocked'}),/outside/);
});
