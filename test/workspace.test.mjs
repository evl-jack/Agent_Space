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
    if(method==='thread/start'||method==='thread/fork'){const id=randomUUID();const role=/You are the (lead|runner|reporter)/.exec(p.baseInstructions)[1];this.threads.set(id,role);return {thread:{id}};}
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
  const calls=[];const team=new Team(f.store,()=>{},{runtimeRoots:[],clientFactory:()=>new FakeClient(calls)});team.liveEnabled=true;
  const task=team.start(f.p.id,'lead','Write a scoped file.');await until(()=>!team.running.size);
  assert.equal(task.status,'completed');assert.equal(task.delegations,1);assert.equal(await fs.readFile(path.join(f.project,'runner.txt'),'utf8'),'written by scoped runner');
  assert.equal(calls.filter(c=>c.method==='turn/start').length,3);assert.equal(JSON.stringify(calls).includes('OTHER_PROJECT_SENTINEL'),false);
  const starts=calls.filter(c=>c.method==='thread/start');assert.equal(starts[0].p.config.mcp_servers.external.enabled,false);assert.equal(starts[0].p.config.features.apps,false);assert.equal(starts[0].p.permissions,'space_read');
});
test('Reporter only runs on request and never starts a Runner',async()=>{
  const f=await fixture();const calls=[];const team=new Team(f.store,()=>{},{runtimeRoots:[],clientFactory:()=>new FakeClient(calls)});team.liveEnabled=true;
  assert.equal(calls.length,0);const task=team.start(f.p.id,'reporter','Summarize current evidence.');await until(()=>!team.running.size);assert.equal(task.status,'completed');assert.equal(calls.filter(c=>c.method==='thread/start').length,1);assert.equal(f.store.data.messages.filter(m=>m.role==='reporter').length,1);
});
test('native fork uses overridden project permissions and defers inherited goal continuation',async()=>{
  const f=await fixture();f.p.sourceMode='fork';f.p.sourceThreadId='synthetic-source';const calls=[];
  const team=new Team(f.store,()=>{},{runtimeRoots:[],clientFactory:()=>new FakeClient(calls)});team.liveEnabled=true;team.start(f.p.id,'lead','Continue');await until(()=>!team.running.size);
  const fork=calls.find(c=>c.method==='thread/fork');assert.equal(fork.p.ephemeral,true);assert.equal(fork.p.deferGoalContinuation,true);assert.equal(fork.p.permissions,'space_read');assert.equal(fork.p.cwd,f.project);
});
test('Stop closes every owned client and finishes the task without a retry',async()=>{
  const f=await fixture();const calls=[];const clients=[];const team=new Team(f.store,()=>{},{runtimeRoots:[],clientFactory:()=>{const c=new FakeClient(calls,{hang:true});clients.push(c);return c;}});team.liveEnabled=true;
  const task=team.start(f.p.id,'lead','Wait');await until(()=>calls.some(c=>c.method==='turn/start'));await team.stop(task.id);await until(()=>!team.running.size);assert.equal(task.status,'stopped');assert.equal(clients.every(c=>c.closed),true);assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
});

async function appFixture(t){
  const f=await fixture();const app=await createWorkspace({root,dataDir:path.join(f.folder,'http'),port:0,inspect:async()=>({connected:true,plan:'test',models:[{id:'test-model',name:'Test model'}]})});t.after(()=>app.close());
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
test('file checkpoint restore preserves newer edits and can restore the matching saved version',async t=>{
  const f=await appFixture(t);const p=await f.app.store.addProject({name:'Recovery',root:f.project});
  const taskId=randomUUID();const run={project:p,task:{id:taskId}};
  const result=await f.app.team.executeTool(run,{},'runner','write_project_file',{path:'readme.txt',content:'runner version'});
  await fs.writeFile(path.join(f.project,'readme.txt'),'newer user version');assert.equal((await f.call('/api/restore','POST',{projectId:p.id,backupId:result.backupId})).status,400);
  assert.equal(await fs.readFile(path.join(f.project,'readme.txt'),'utf8'),'newer user version');
  await fs.writeFile(path.join(f.project,'readme.txt'),'runner version');assert.equal((await f.call('/api/restore','POST',{projectId:p.id,backupId:result.backupId})).status,200);assert.equal(await fs.readFile(path.join(f.project,'readme.txt'),'utf8'),'project evidence');
});
