import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from './store.mjs';
import { Team } from './team.mjs';
import { inspectConnection, CodexClient } from './codex.mjs';
import { githubRepo, resolveProjectPath, listProjectFiles, inside } from './policy.mjs';

const exec=promisify(execFile);
const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};
async function body(request) {
  let text='';for await(const chunk of request){text+=chunk;if(Buffer.byteLength(text)>200000)throw new Error('The request is too large.');}
  try{return JSON.parse(text||'{}');}catch{throw new Error('Send valid JSON.');}
}
export function allowedRequest(request, origin, token, { session = false } = {}) {
  if(request.headers.host!==new URL(origin).host)return false;
  if(request.headers.origin&&request.headers.origin!==origin)return false;
  if(session)return true;
  const cookie=request.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('agent_space='))?.slice(12);
  if(!equal(cookie,token))return false;
  if(request.method!=='GET'&&!equal(request.headers['x-agent-space-token'],token))return false;
  return true;
}
export async function createWorkspace({root=appRoot,dataDir=path.join(root,'.local'),port=4317,inspect=inspectConnection,teamFactory}={}) {
  const store=await new Store(dataDir).open();
  const token=randomBytes(32).toString('hex');const streams=new Set();let origin;let connection={connected:false,models:[],checkedAt:null};let inspecting=null;
  const broadcast=(event,data)=>{for(const stream of streams)stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
  const team=teamFactory?teamFactory(store,broadcast):new Team(store,broadcast);
  const json=(response,status,data)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(data));};
  const server=http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,origin);
      if(request.headers.host!==new URL(origin).host){json(response,403,{error:'This workspace accepts only its local address.'});return;}
      if(url.pathname==='/api/session'&&request.method==='POST'){
        if(!allowedRequest(request,origin,token,{session:true}))throw new Error('This page is not allowed to open a session.');
        const input=await body(request);if(!equal(input.token,token)){json(response,401,{error:'Open the workspace using its local launcher.'});return;}
        response.setHeader('Set-Cookie',`agent_space=${token}; HttpOnly; SameSite=Strict; Path=/`);json(response,200,{csrf:token});return;
      }
      if(url.pathname.startsWith('/api/')){
        if(!allowedRequest(request,origin,token)){json(response,401,{error:'Open the workspace using its local launcher.'});return;}
        if(url.pathname==='/api/session'&&request.method==='GET'){json(response,200,{csrf:token});return;}
        if(url.pathname==='/api/state'&&request.method==='GET'){
          const snapshot=store.snapshot();for(const p of snapshot.projects)p.approvedSpaces=team.spaces.list(p.id);
          json(response,200,{...snapshot,connection,liveEnabled:team.liveEnabled});return;
        }
        if(url.pathname==='/api/events'&&request.method==='GET'){
          response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});response.write(': connected\n\n');streams.add(response);request.on('close',()=>streams.delete(response));return;
        }
        if(url.pathname==='/api/connection'&&request.method==='POST'){
          if(!inspecting)inspecting=inspect().then(result=>connection=result).finally(()=>inspecting=null);
          await inspecting;json(response,200,connection);return;
        }
        if(url.pathname==='/api/live'&&request.method==='POST'){
          const input=await body(request);if(typeof input.enabled!=='boolean')throw new Error('Choose whether to enable live tasks.');
          if(input.enabled&&!connection.connected)throw new Error('Check your Codex connection before enabling live tasks.');
          team.liveEnabled=input.enabled;if(!input.enabled)await team.close();broadcast('live',{enabled:team.liveEnabled});json(response,200,{enabled:team.liveEnabled});return;
        }
        if(url.pathname==='/api/projects'&&request.method==='POST'){const p=await store.addProject(await body(request));broadcast('project',p);json(response,201,p);return;}
        const removal=/^\/api\/projects\/([a-zA-Z0-9-]+)\/spaces\/([a-zA-Z0-9-]+)$/.exec(url.pathname);
        if(removal&&request.method==='DELETE'){
          const [,,id]=removal;const projectId=removal[1];const grant=team.spaces.list(projectId).find(g=>g.id===id);
          if(!grant||id==='main')throw new Error('Choose an additional approved space to remove.');
          await team.updateSpaces(projectId,()=>team.spaces.remove(projectId,id),{revoke:true});
          team.event(projectId,'user','permission',`Access removed: ${grant.label}. Running project tasks were stopped.`);
          json(response,200,{removed:true});return;
        }
        const projectRoute=/^\/api\/projects\/([a-zA-Z0-9-]+)(?:\/(source|git|spaces))?$/.exec(url.pathname);
        if(projectRoute){
          const original=store.project(projectRoute[1]);const p=structuredClone(original);const action=projectRoute[2];
          if(action==='spaces'&&request.method==='POST'){
            const input=await body(request);if(input.userApproved!==true)throw new Error('Explicitly approve the folder before adding access.');
            const grant=await team.updateSpaces(p.id,async()=>{
              if(input.taskId){const run=team.running.get(input.taskId);if(!run||run.project.id!==p.id||run.stopped)throw new Error('That task has finished. Choose the next Lead task instead.');}
              return team.spaces.add(p.id,input);
            });
            team.event(p.id,'user','permission',`Approved ${grant.label}: ${grant.access==='write'?'read/write':'read-only'}, ${grant.duration}${grant.duration==='task'&&!grant.taskId?' (next Lead task)':''}.`);
            json(response,201,grant);return;
          }
          if(action==='git'&&request.method==='GET'){
            try{
              const {stdout:rootPath}=await exec('git',['-C',p.root,'rev-parse','--show-toplevel'],{windowsHide:true,timeout:10000});
              if(path.resolve(rootPath.trim()).toLowerCase()!==p.root.toLowerCase()){json(response,200,{connected:false,reason:'This folder is inside a different repository.'});return;}
              const {stdout:branch}=await exec('git',['-C',p.root,'branch','--show-current'],{windowsHide:true,timeout:10000});
              const {stdout:changes}=await exec('git',['-C',p.root,'status','--short'],{windowsHide:true,timeout:10000});
              json(response,200,{connected:true,branch:branch.trim(),changes:changes.trim().split('\n').filter(Boolean).length});
            }catch{json(response,200,{connected:false,reason:'No Git checkout is connected here yet.'});}return;
          }
          if(action==='source'&&request.method==='POST'){
            const {threadId}=await body(request);if(!/^[a-zA-Z0-9_-]{8,100}$/.test(threadId||''))throw new Error('Enter a valid Codex source chat ID.');
            const client=new CodexClient();try{await client.open();const r=await client.request('thread/read',{threadId,includeTurns:false});json(response,200,{id:r.thread.id,name:r.thread.name||'Source chat',cwd:r.thread.cwd,preview:r.thread.preview||''});}finally{await client.close();}return;
          }
          if(!action&&request.method==='PATCH'){
            if([...team.running.values()].some(r=>r.project.id===p.id))throw new Error('Stop this project’s tasks before changing its settings.');
            const input=await body(request);
            if(input.name!==undefined)p.name=String(input.name).trim().slice(0,80)||p.name;
            if(input.names){
              if(typeof input.names!=='object'||Array.isArray(input.names))throw new Error('Enter an agent name for each role.');
              for(const role of ['lead','runner','reporter'])if(input.names[role]!==undefined){
                const name=input.names[role];if(typeof name!=='string'||!name.trim()||[...name.trim()].length>32||/[\u0000-\u001f\u007f]/.test(name))throw new Error('Agent names must contain 1–32 characters on one line.');
                p.names[role]=name.trim();
              }
            }
            if(input.repository!==undefined)p.repository=githubRepo(input.repository);
            if(input.brief!==undefined)p.brief=String(input.brief).slice(0,6000);
            if(input.sourceThreadId!==undefined){if(input.sourceThreadId&&!/^[a-zA-Z0-9_-]{8,100}$/.test(input.sourceThreadId))throw new Error('Invalid source chat ID.');p.sourceThreadId=input.sourceThreadId||null;}
            if(input.sourceMode!==undefined){if(!['handoff','fork'].includes(input.sourceMode))throw new Error('Choose compact handoff or native fork.');p.sourceMode=input.sourceMode;}
            if(input.models){for(const role of ['lead','runner','reporter'])if(input.models[role]){if(!connection.models.some(m=>m.id===input.models[role]))throw new Error('Select an available model after checking the connection.');p.models[role]=input.models[role];}}
            if(input.efforts!==undefined){
              if(!input.efforts||typeof input.efforts!=='object'||Array.isArray(input.efforts))throw new Error('Choose a performance setting for each agent.');
              for(const role of ['lead','runner','reporter'])if(input.efforts[role]!==undefined)p.efforts[role]=input.efforts[role];
            }
            if(input.models||input.efforts){
              for(const role of ['lead','runner','reporter']){
                const model=connection.models.find(m=>m.id===p.models[role]);
                if(!model)throw new Error('Check the Codex connection before changing agent performance.');
                if(typeof p.efforts[role]!=='string'||!model.efforts?.includes(p.efforts[role]))throw new Error(`Choose a supported performance setting for the ${role} model.`);
              }
            }
            if(input.limits){const limits=input.limits;if(!Number.isInteger(limits.tokens)||limits.tokens<1000||limits.tokens>200000||!Number.isInteger(limits.minutes)||limits.minutes<1||limits.minutes>60||!Number.isInteger(limits.delegations)||limits.delegations<1||limits.delegations>6)throw new Error('Use 1,000–200,000 tokens, 1–60 minutes, and 1–6 Runner delegations.');p.limits=limits;}
            Object.assign(original,p);await store.save();broadcast('project',p);json(response,200,p);return;
          }
        }
        if(url.pathname==='/api/files'&&request.method==='GET'){
          const spaces=team.spaces.forTask(url.searchParams.get('projectId'),null);const grant=spaces.find(g=>g.id===(url.searchParams.get('spaceId')||'main'));
          if(!grant)throw new Error('This folder is not currently approved for browsing.');
          const target=await resolveProjectPath(grant.root,url.searchParams.get('path')||'');
          if(team.spaces.forbidden.some(folder=>inside(folder,target)))throw new Error('Application records cannot be browsed through project tools.');
          json(response,200,await listProjectFiles(grant.root,url.searchParams.get('path')||''));return;
        }
        if(url.pathname==='/api/tasks'&&request.method==='POST'){const input=await body(request);json(response,202,team.start(input.projectId,input.role,input.prompt));return;}
        const stop=/^\/api\/tasks\/([a-zA-Z0-9-]+)\/stop$/.exec(url.pathname);
        if(stop&&request.method==='POST'){await team.stop(stop[1]);json(response,200,{stopped:true});return;}
        if(url.pathname==='/api/restore'&&request.method==='POST'){
          const input=await body(request);const event=store.data.events.find(e=>e.backupId===input.backupId&&e.projectId===input.projectId);if(!event)throw new Error('No saved file checkpoint matches this project.');
          if([...team.running.values()].some(r=>r.project.id===input.projectId))throw new Error('Stop the project’s tasks before restoring a file.');
          const p=store.project(input.projectId);const record=JSON.parse(await fs.readFile(path.join(store.folder,'backups',event.taskId,`${event.backupId}.json`),'utf8'));
          const grant=team.spaces.forTask(p.id,null).find(g=>g.root.toLowerCase()===(record.root||p.root).toLowerCase()&&g.access==='write');
          if(!grant)throw new Error('Reapprove the checkpoint folder for this session or project before restoring.');
          const target=await resolveProjectPath(grant.root,record.path,{write:true});
          if(team.spaces.forbidden.some(folder=>inside(folder,target)))throw new Error('Application records cannot be restored through project tools.');
          const current=await fs.readFile(target,'utf8');
          if(createHash('sha256').update(current).digest('hex')!==record.writtenHash)throw new Error('The file changed after this checkpoint. Review it manually so newer work is preserved.');
          if(record.previous===null)await fs.unlink(target);else await fs.writeFile(target,record.previous,'utf8');
          const e=store.event(p.id,'user','restored',`Restored ${record.path}`);broadcast('event',e);json(response,200,{restored:record.path});return;
        }
        json(response,404,{error:'This action is not available.'});return;
      }
      const staticPaths={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
      const file=staticPaths[url.pathname];if(!file||request.method!=='GET'){response.writeHead(404);response.end();return;}
      response.writeHead(200,{'Content-Type':types[path.extname(file)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});response.end(await fs.readFile(path.join(root,'public',file)));
    }catch(e){if(!response.headersSent)json(response,400,{error:e.message});else response.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  const launchUrl=`${origin}/#token=${token}`;
  await fs.writeFile(path.join(dataDir,'connection.json'),JSON.stringify({origin,token,pid:process.pid}),{mode:0o600});
  const heartbeat=setInterval(()=>{for(const stream of streams)stream.write(': heartbeat\n\n');},20000);heartbeat.unref();
  return {server,store,team,origin,token,launchUrl,async close(){clearInterval(heartbeat);await team.close();for(const stream of streams)stream.end();await store.save();await new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createWorkspace({port:Number(process.env.AGENT_SPACE_PORT||4317)});
  console.log(`Agent Space is running locally. Open ${app.launchUrl}`);
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
}
