import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {launchWorkspace} from '../scripts/launch.mjs';
import {createWorkspace} from '../server/main.mjs';
import {findCodex} from '../server/codex.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function fixture(){const folder=path.join(root,'.local','launcher-tests',randomUUID());await fs.mkdir(folder,{recursive:true});return {folder,dataDir:path.join(folder,'.local')};}
test('a fresh copy with an occupied preferred port starts on an available port',async t=>{
  const f=await fixture();const occupying=await createWorkspace({root,dataDir:path.join(f.folder,'occupying'),port:0});t.after(()=>occupying.close());
  const app=await launchWorkspace({root,dataDir:f.dataDir,port:Number(new URL(occupying.origin).port)});t.after(()=>app.app.close());
  assert.equal(app.changedPort,true);assert.notEqual(new URL(app.launchUrl).port,new URL(occupying.launchUrl).port);
  const saved=JSON.parse(await fs.readFile(path.join(f.dataDir,'connection.json'),'utf8'));assert.equal(saved.origin,app.app.origin);
});
test('launching the same running copy reuses its authenticated local session',async t=>{
  const f=await fixture();const first=await launchWorkspace({root,dataDir:f.dataDir,port:0});t.after(()=>first.app.close());
  const second=await launchWorkspace({root,dataDir:f.dataDir,port:0,create:()=>{throw new Error('Must reuse the running copy.');}});
  assert.equal(second.reused,true);assert.equal(second.app,null);assert.equal(second.launchUrl,first.launchUrl);
});
test('a stale session file does not prevent a fresh launch',async t=>{
  const f=await fixture();await fs.mkdir(f.dataDir);await fs.writeFile(path.join(f.dataDir,'connection.json'),JSON.stringify({origin:'http://127.0.0.1:1',token:'a'.repeat(64)}));
  const app=await launchWorkspace({root,dataDir:f.dataDir,port:0,fetcher:async()=>{throw new Error('Old process stopped.');}});t.after(()=>app.app.close());assert.equal(app.reused,false);
});
test('startup permission errors are preserved instead of mistaken for a port collision',async()=>{
  const f=await fixture();await assert.rejects(()=>launchWorkspace({root,dataDir:f.dataDir,create:async()=>{const e=new Error('No access to the extracted folder.');e.code='EACCES';throw e;}}),/No access/);
});
test('desktop Codex is discovered when Explorer PATH has no Codex entry',async()=>{
  const f=await fixture();const executable=path.join(f.folder,'OpenAI','Codex','bin','desktop-version','codex.exe');await fs.mkdir(path.dirname(executable),{recursive:true});await fs.writeFile(executable,'synthetic executable path; never run');
  assert.equal(findCodex({env:{LOCALAPPDATA:f.folder},lookup(){throw new Error('Not on PATH');}}),executable);
});
