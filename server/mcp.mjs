import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
const folder=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.local');
const tools=[
  {name:'workspace_status',description:'Read local workspace connection status and project names. Does not start agents or model requests.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},
  {name:'project_activity',description:'Read recent activity for one explicitly selected local project. Does not inspect other projects.',inputSchema:{type:'object',properties:{projectId:{type:'string'}},required:['projectId'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}
];
async function getState(){
  let connection;try{connection=JSON.parse(await fs.readFile(path.join(folder,'connection.json'),'utf8'));}catch{throw new Error('Open Agent Space using Start.cmd first.');}
  const url=new URL(connection.origin);if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw new Error('Invalid local workspace address.');
  const response=await fetch(`${connection.origin}/api/state`,{headers:{Cookie:`agent_space=${connection.token}`},signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('The workspace session expired. Restart Agent Space.');
  return {state:await response.json(),origin:connection.origin};
}
async function handle(message){
  if(message.id===undefined)return;
  try{
    let result;
    if(message.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'agent-space',version:'0.2.6'}};
    else if(message.method==='ping')result={};
    else if(message.method==='tools/list')result={tools};
    else if(message.method==='tools/call'){
      const {state,origin}=await getState();let value;
      if(message.params?.name==='workspace_status')value={url:origin,liveEnabled:state.liveEnabled,connected:state.connection.connected,projects:state.projects.map(p=>({id:p.id,name:p.name}))};
      else if(message.params?.name==='project_activity'){
        const id=message.params.arguments?.projectId;const project=state.projects.find(p=>p.id===id);if(!project)throw new Error('Select a project returned by workspace_status.');
        value={project:{id,name:project.name},events:state.events.filter(e=>e.projectId===id).slice(-30),tasks:state.tasks.filter(t=>t.projectId===id).slice(-5)};
      }else throw new Error('Unknown workspace tool.');
      result={content:[{type:'text',text:JSON.stringify(value)}]};
    }else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}})+'\n');return;}
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
  }catch(e){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:e.message}]}})+'\n');}
}
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{try{handle(JSON.parse(line));}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n');}});
