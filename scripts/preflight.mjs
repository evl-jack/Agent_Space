// Checks local protocol and OS boundaries. Never calls turn/start or model generation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CodexClient, findCodex } from '../server/codex.mjs';
import { profileArguments } from '../server/policy.mjs';
import { isolatedThreadConfig, runnerTools } from '../server/team.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder=path.join(root,'.local','preflight',randomUUID());const project=path.join(folder,'project');const outside=path.join(folder,'outside');
await fs.mkdir(path.join(project,'.git'),{recursive:true});await fs.mkdir(outside);await fs.writeFile(path.join(project,'inside.txt'),'synthetic');await fs.writeFile(path.join(outside,'canary.txt'),'synthetic');
const reference=path.join(folder,'reference');const shared=path.join(folder,'shared');await fs.mkdir(reference);await fs.mkdir(path.join(shared,'.git'),{recursive:true});await fs.writeFile(path.join(reference,'notes.txt'),'synthetic');
const approvedSpaces=[{id:'main',root:project,access:'write'},{id:'reference',root:reference,access:'read'},{id:'shared',root:shared,access:'write'}];
const client=new CodexClient({args:profileArguments({root:project,approvedSpaces},[path.dirname(process.execPath),path.dirname(findCodex())])});
try{
  await client.open();const config=await client.request('config/read',{includeLayers:false});
  const account=await client.request('account/read',{refreshToken:false});console.log(JSON.stringify({check:'account',type:account.account?.type,plan:account.account?.planType}));
  const script=`const fs=require('node:fs');const project=${JSON.stringify(project)},outside=${JSON.stringify(outside)},reference=${JSON.stringify(reference)},shared=${JSON.stringify(shared)};const probes=[['read_inside',()=>fs.readFileSync(project+'/inside.txt')],['read_outside',()=>fs.readFileSync(outside+'/canary.txt')],['write_inside',()=>fs.writeFileSync(project+'/created.txt','synthetic')],['write_outside',()=>fs.writeFileSync(outside+'/created.txt','synthetic')],['write_git',()=>fs.writeFileSync(project+'/.git/protected','synthetic')],['read_reference',()=>fs.readFileSync(reference+'/notes.txt')],['write_reference',()=>fs.writeFileSync(reference+'/denied.txt','synthetic')],['write_shared',()=>fs.writeFileSync(shared+'/created.txt','synthetic')],['write_shared_git',()=>fs.writeFileSync(shared+'/.git/denied','synthetic')]];for(const [name,action]of probes){try{action();console.log(JSON.stringify({name,allowed:true}));}catch(e){console.log(JSON.stringify({name,allowed:false,error:e.code}));}}`;
  const result=await client.request('command/exec',{command:[process.execPath,'-e',script],cwd:project,permissionProfile:'space_execute',timeoutMs:10000});
  if(result.exitCode!==0)throw new Error(`Boundary command failed: ${result.stderr}`);
  const probes=result.stdout.trim().split(/\r?\n/).map(JSON.parse);for(const probe of probes){const expected=['read_inside','write_inside','read_reference','write_shared'].includes(probe.name);if(probe.allowed!==expected)throw new Error(`Boundary mismatch: ${probe.name}`);}
  console.log(JSON.stringify({check:'read_write_boundaries',probes}));
  const thread=await client.request('thread/start',{cwd:project,model:'gpt-6-luna',permissions:'space_read',approvalPolicy:'on-request',ephemeral:true,baseInstructions:'Metadata check only. No work is requested.',config:isolatedThreadConfig(config.config||{}),dynamicTools:runnerTools});
  if(!thread.thread?.id)throw new Error('No temporary thread metadata returned.');
  console.log(JSON.stringify({check:'temporary_thread_and_tool_schema',ok:true,generationRequests:0}));
}finally{await client.close();}
