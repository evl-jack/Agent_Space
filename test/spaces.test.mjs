import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Store} from '../server/store.mjs';
import {Spaces} from '../server/spaces.mjs';
import {Team} from '../server/team.mjs';
import {createWorkspace} from '../server/main.mjs';
import {profileDefinitions} from '../server/policy.mjs';

const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function fixture(){
  const base=path.join(appRoot,'.local','space-tests',randomUUID());
  const roots=Object.fromEntries(['main','shared','second','otherProject'].map(k=>[k,path.join(base,k)]));
  for(const root of Object.values(roots))await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(roots.shared,'notes.txt'),'shared evidence');
  const store=await new Store(path.join(base,'private')).open();const p=await store.addProject({name:'Main',root:roots.main});
  const spaces=new Spaces(store);return {base,roots,store,p,spaces};
}
test('only project-duration permissions survive a restart and remain project-scoped',async()=>{
  const f=await fixture();const second=await f.store.addProject({name:'Separate',root:f.roots.otherProject});
  await f.spaces.add(f.p.id,{root:f.roots.shared,access:'read',duration:'project'});
  await f.spaces.add(f.p.id,{root:f.roots.second,access:'write',duration:'session'});
  assert.equal(f.spaces.forTask(second.id,null).length,1);
  const reopened=await new Store(f.store.folder).open();const spaces=new Spaces(reopened);
  assert.equal(spaces.list(f.p.id).length,2);assert.equal(spaces.list(f.p.id)[1].duration,'project');
});
test('task permission is consumed by the next Lead task, not a Reporter question, and expires',async()=>{
  const f=await fixture();const grant=await f.spaces.add(f.p.id,{root:f.roots.shared,access:'read',duration:'task'});
  f.spaces.bindNext(f.p.id,'report','reporter');assert.equal(f.spaces.forTask(f.p.id,'report').length,1);
  f.spaces.bindNext(f.p.id,'lead-task','lead');assert.equal(f.spaces.forTask(f.p.id,'lead-task')[1].id,grant.id);
  assert.equal(f.spaces.forTask(f.p.id,'unrelated-task').length,1);f.spaces.finish(f.p.id,'lead-task');assert.equal(f.spaces.list(f.p.id).length,1);
});
test('overlapping folders and application-private records cannot be separately approved',async()=>{
  const f=await fixture();await assert.rejects(()=>f.spaces.add(f.p.id,{root:f.base,access:'write',duration:'session'}),/overlaps/);
  await assert.rejects(()=>f.spaces.add(f.p.id,{root:f.store.folder,access:'read',duration:'project'}),/records/);
  await f.spaces.add(f.p.id,{root:f.roots.shared,access:'read',duration:'session'});
  await assert.rejects(()=>f.spaces.add(f.p.id,{root:f.roots.shared,access:'write',duration:'task'}),/overlaps/);
});
test('checked file tools respect read-only extra spaces and reject access after revocation',async()=>{
  const f=await fixture();const team=new Team(f.store,()=>{},{spaces:f.spaces});const run={project:structuredClone(f.p),task:{id:randomUUID()}};
  const grant=await f.spaces.add(f.p.id,{root:f.roots.shared,access:'read',duration:'session'});
  assert.equal(await team.executeTool(run,{},'reporter','read_project_file',{spaceId:grant.id,path:'notes.txt'}),'shared evidence');
  await assert.rejects(()=>team.executeTool(run,{},'runner','write_project_file',{spaceId:grant.id,path:'notes.txt',content:'denied'}),/read-only/);
  await f.spaces.remove(f.p.id,grant.id);await assert.rejects(()=>team.executeTool(run,{},'runner','read_project_file',{spaceId:grant.id,path:'notes.txt'}),/not approved/);
  assert.equal(await fs.readFile(path.join(f.roots.shared,'notes.txt'),'utf8'),'shared evidence');
});
test('mixed-space OS profiles preserve access levels and protect metadata at every root',async()=>{
  const f=await fixture();const read=await f.spaces.add(f.p.id,{root:f.roots.shared,access:'read',duration:'project'});const write=await f.spaces.add(f.p.id,{root:f.roots.second,access:'write',duration:'session'});
  const profiles=profileDefinitions({...f.p,approvedSpaces:f.spaces.forTask(f.p.id,null),protectedRoots:[f.store.folder]});
  assert.equal(profiles.space_execute.filesystem[read.root],'read');assert.equal(profiles.space_execute.filesystem[write.root],'write');
  assert.equal(profiles.space_execute.filesystem[path.join(write.root,'.git')],'deny');assert.equal(profiles.space_read.filesystem[f.store.folder],'deny');
});
test('approving an ancestor cannot expose private records through checked file tools',async()=>{
  const f=await fixture();const privateFolder=path.join(f.roots.shared,'private-records');await fs.mkdir(privateFolder);await fs.writeFile(path.join(privateFolder,'secret.txt'),'synthetic private');
  f.spaces.forbidden.push(privateFolder);const grant=await f.spaces.add(f.p.id,{root:f.roots.shared,access:'read',duration:'session'});
  const team=new Team(f.store,()=>{},{spaces:f.spaces});const run={project:f.p,task:{id:'synthetic-task'}};
  await assert.rejects(()=>team.executeTool(run,{},'runner','read_project_file',{spaceId:grant.id,path:'private-records/secret.txt'}),/records/);
});
test('an approval update waits for the active action and queued tools see the new approval',async()=>{
  const f=await fixture();const team=new Team(f.store,()=>{},{spaces:f.spaces});let release;const active=new Promise(r=>release=r);
  const run={task:{id:randomUUID()},project:structuredClone(f.p),clients:new Set(),threads:new Map([['runner-thread',{role:'runner'}]]),activeAction:active,stopped:false};team.running.set(run.task.id,run);
  const updating=team.updateSpaces(f.p.id,()=>f.spaces.add(f.p.id,{root:f.roots.shared,access:'read',duration:'session'}));
  let response;const client={respond(id,result){response=result;}};
  const queued=team.handleRequest(run,client,{id:1,method:'item/tool/call',params:{threadId:'runner-thread',tool:'list_approved_spaces',arguments:{}}});
  await new Promise(r=>setTimeout(r,5));assert.equal(f.spaces.list(f.p.id).length,1);assert.equal(response,undefined);
  release();const grant=await updating;await queued;
  assert.ok(JSON.parse(response.contentItems[0].text).some(g=>g.id===grant.id));assert.equal(run.project.approvedSpaces.length,2);team.running.clear();
});
test('revocation closes the project’s owned clients before removing access',async()=>{
  const f=await fixture();const team=new Team(f.store,()=>{},{spaces:f.spaces});const grant=await f.spaces.add(f.p.id,{root:f.roots.shared,access:'write',duration:'session'});let closed=false;
  const run={task:{id:randomUUID(),role:'lead'},project:structuredClone(f.p),clients:new Set([{async close(){closed=true;}}]),stopped:false};team.running.set(run.task.id,run);
  await team.updateSpaces(f.p.id,async()=>{assert.equal(closed,true);await f.spaces.remove(f.p.id,grant.id);},{revoke:true});
  assert.equal(run.task.status,'stopped');assert.equal(f.spaces.list(f.p.id).length,1);team.running.clear();
});
test('HTTP approval requires explicit consent and supports removal without widening another project',async t=>{
  const f=await fixture();const app=await createWorkspace({root:appRoot,dataDir:f.store.folder,port:0});t.after(()=>app.close());
  const headers={Cookie:`agent_space=${app.token}`,Origin:app.origin,'X-Agent-Space-Token':app.token,'Content-Type':'application/json'};
  const call=(url,method,input)=>fetch(app.origin+url,{method,headers,...(input?{body:JSON.stringify(input)}:{})});
  const url=`/api/projects/${f.p.id}/spaces`;const input={root:f.roots.shared,access:'read',duration:'session'};
  assert.equal((await call(url,'POST',input)).status,400);
  const response=await call(url,'POST',{...input,userApproved:true});assert.equal(response.status,201);const grant=await response.json();
  const snapshot=await(await call('/api/state','GET')).json();assert.equal(snapshot.projects[0].approvedSpaces.length,2);
  assert.equal((await call(url+'/main','DELETE')).status,400);assert.equal((await call(url+'/'+grant.id,'DELETE')).status,200);
  assert.equal(app.team.spaces.list(f.p.id).length,1);
});
