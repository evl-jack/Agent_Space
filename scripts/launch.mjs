import { createWorkspace } from '../server/main.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const applicationRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

const stopOwnedProcess=async pid=>{process.kill(pid,'SIGTERM');};

async function runningCopy(dataDir,fetcher) {
  try {
    const connection=JSON.parse(await fs.readFile(path.join(dataDir,'connection.json'),'utf8'));
    const origin=new URL(connection.origin);
    if(origin.hostname!=='127.0.0.1'||origin.protocol!=='http:'||origin.origin!==connection.origin||!/^[a-f0-9]{64}$/.test(connection.token))return null;
    const response=await fetcher(`${origin.origin}/api/state`,{headers:{Cookie:`agent_space=${connection.token}`},signal:AbortSignal.timeout(2000)});
    if(!response.ok)return null;
    const state=await response.json();if(!Array.isArray(state.projects)||typeof state.liveEnabled!=='boolean')return null;
    return {connection,state,app:null,reused:true,changedPort:false,launchUrl:`${origin.origin}/#token=${connection.token}`};
  } catch { return null; }
}

export async function launchWorkspace({root=applicationRoot,dataDir=path.join(root,'.local'),port=4317,create=createWorkspace,fetcher=fetch,stopProcess=stopOwnedProcess}={}) {
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('AGENT_SPACE_PORT must be a port number from 0 to 65535.');
  let oldLive=false;
  const currentVersion=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
  const existing=await runningCopy(dataDir,fetcher);
  if(existing){
    if(existing.state.appVersion===currentVersion)return existing;
    const active=existing.state.tasks?.some(t=>['running','queued'].includes(t.status));
    if(active||!Number.isInteger(existing.connection.pid)||(existing.connection.pid===process.pid&&stopProcess===stopOwnedProcess))return {...existing,updatePending:true};
    // The authenticated session comes from this copy’s private data directory.
    // Never stop a busy copy just to install an agent-role update.
    const headers={Cookie:'agent_space='+existing.connection.token,'X-Agent-Space-Token':existing.connection.token,'Content-Type':'application/json'};
    const latest=await(await fetcher(existing.connection.origin+'/api/state',{headers,signal:AbortSignal.timeout(2000)})).json();
    if(latest.tasks?.some(t=>['running','queued'].includes(t.status)))return {...existing,updatePending:true};
    oldLive=latest.liveEnabled;
    const paused=await fetcher(existing.connection.origin+'/api/live',{method:'POST',headers,body:JSON.stringify({enabled:false}),signal:AbortSignal.timeout(3000)});
    if(!paused.ok)throw new Error('Could not pause the idle older copy for updating.');
    await stopProcess(existing.connection.pid);
    for(let attempt=0;attempt<30;attempt++){
      if(!await runningCopy(dataDir,fetcher))break;
      if(attempt===29)throw new Error('The older copy is still closing. Open Agent Space again in a moment.');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  const start=async preferredPort=>{
    const app=await create({root,dataDir,port:preferredPort});
    if(oldLive){
      const headers={Cookie:'agent_space='+app.token,'X-Agent-Space-Token':app.token,'Content-Type':'application/json'};
      try{const checked=await(await fetcher(app.origin+'/api/connection',{method:'POST',headers})).json();if(checked.connected)await fetcher(app.origin+'/api/live',{method:'POST',headers,body:JSON.stringify({enabled:true})});}catch{}
    }
    return app;
  };
  try {
    const app=await start(port);return {app,launchUrl:app.launchUrl,reused:false,changedPort:false};
  } catch(error) {
    if(error.code!=='EADDRINUSE')throw error;
    // A different extracted copy may own the preferred port. Do not assume this
    // fresh copy has its connection.json, and do not share the other copy's data.
    const startedMeanwhile=await runningCopy(dataDir,fetcher);if(startedMeanwhile)return startedMeanwhile;
    const app=await start(0);return {app,launchUrl:app.launchUrl,reused:false,changedPort:true};
  }
}

export function appBrowser(env=process.env) {
  const locations=[
    [env.ProgramFiles,'Google','Chrome','Application','chrome.exe'],
    [env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe'],
    [env['ProgramFiles(x86)'],'Microsoft','Edge','Application','msedge.exe'],
    [env.ProgramFiles,'Microsoft','Edge','Application','msedge.exe'],
    [env.LOCALAPPDATA,'Microsoft','Edge','Application','msedge.exe']
  ];
  return locations.filter(parts=>parts[0]).map(parts=>path.join(...parts)).find(existsSync)||null;
}

export function openWorkspaceWindow(url,{browser=appBrowser(),mode=process.env.AGENT_SPACE_WINDOW_MODE||'app',spawnProcess=spawn}={}) {
  if(mode==='app'&&browser)return new Promise((resolve,reject)=>{
    const child=spawnProcess(browser,[`--app=${url}`,'--new-window','--window-size=1280,900'],{windowsHide:true,stdio:'ignore'});
    child.once('error',reject);child.once('spawn',()=>resolve({mode:'app'}));
  });
  return new Promise((resolve,reject)=>{
    const child=spawnProcess('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'});
    child.once('error',reject);child.once('exit',code=>code===0?resolve({mode:'browser'}):reject(new Error('The browser could not open. Copy the local address shown above.')));
  });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let app;
  try {
    const result=await launchWorkspace({port:Number(process.env.AGENT_SPACE_PORT||4317)});app=result.app;
    if(result.updatePending)console.log('An update is ready. Finish running work, then reopen Agent Space to load it.');
    if(result.changedPort)console.log('This copy is using another available local address.');
    console.log(`Agent Space: ${result.launchUrl}`);
    if(app)console.log('Keep this window open while using Agent Space. Close it to stop this copy.');
    if(app)for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
    if(process.platform==='win32'&&process.env.AGENT_SPACE_NO_BROWSER!=='1'){
      const window=await openWorkspaceWindow(result.launchUrl);
      console.log(window.mode==='app'?'Opened in a dedicated Agent Space window.':'Opened in your browser. Install Chrome or Edge for a dedicated app window.');
    }
  } catch(error) {
    console.error(`Agent Space could not start: ${error.message}`);
    try {
      const folder=path.join(applicationRoot,'.local');await fs.mkdir(folder,{recursive:true});
      await fs.writeFile(path.join(folder,'launch-error.log'),`${new Date().toISOString()}\n${error.stack||error.message}\n`,{mode:0o600});
      console.error('Details were saved in .local/launch-error.log.');
    } catch {}
    if(app)await app.close();process.exitCode=1;
  }
}
