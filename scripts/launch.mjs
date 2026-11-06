import { createWorkspace } from '../server/main.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
let app;let launchUrl;
try{app=await createWorkspace({port:Number(process.env.AGENT_SPACE_PORT||4317)});launchUrl=app.launchUrl;}
catch(error){
  if(error.code!=='EADDRINUSE')throw error;
  const connection=JSON.parse(await fs.readFile(new URL('../.local/connection.json',import.meta.url),'utf8'));
  const origin=new URL(connection.origin);if(origin.hostname!=='127.0.0.1'||origin.protocol!=='http:')throw new Error('The saved local workspace address is invalid.');
  const response=await fetch(`${origin.origin}/api/state`,{headers:{Cookie:`agent_space=${connection.token}`},signal:AbortSignal.timeout(3000)});
  if(!response.ok)throw new Error('The local port is already in use. Choose a different AGENT_SPACE_PORT.');
  launchUrl=`${origin.origin}/#token=${connection.token}`;
}
console.log(`Agent Space: ${launchUrl}`);
if(process.platform==='win32')spawn('rundll32.exe',['url.dll,FileProtocolHandler',launchUrl],{windowsHide:true,stdio:'ignore'});
if(app)for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
