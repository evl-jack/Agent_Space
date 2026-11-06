import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Publisher,publishIntent} from '../server/publish.mjs';
import {previewFile} from '../server/preview.mjs';
import {parseModel,parseCsv} from '../public/preview.js';
const exec=promisify(execFile);
const base=path.resolve('.local','publish-preview-tests');
async function fixture(){const root=path.join(base,randomUUID());await fs.mkdir(root,{recursive:true});return root;}
test('publishing requires an explicit chat command rather than ordinary reporting or quoted history',()=>{
 for(const value of ['Publish to GitHub: Solver/rung3.py','please commit and push to GitHub: results','Push to GitHub: ReadMe.md'])assert.equal(publishIntent(value),true);
 for(const value of ['What changed?','Do not push to GitHub','The earlier chat said publish to github','Can you summarize the repo?'])assert.equal(publishIntent(value),false);
});
test('publishing commits only selected files and preserves other remote files and local source state',async()=>{
 const root=await fixture(),remote=path.join(root,'remote.git'),seed=path.join(root,'seed'),source=path.join(root,'source');await fs.mkdir(seed);await fs.mkdir(source);
 const env={...process.env,GIT_AUTHOR_NAME:'Synthetic Test',GIT_AUTHOR_EMAIL:'synthetic@example.invalid',GIT_COMMITTER_NAME:'Synthetic Test',GIT_COMMITTER_EMAIL:'synthetic@example.invalid'};
 const git=async(args,cwd=root)=>(await exec('git',args,{cwd,env,windowsHide:true})).stdout.trim();
 await git(['init','--bare',remote]);await git(['init','-b','main'],seed);await fs.writeFile(path.join(seed,'preserved.txt'),'remote only');await git(['add','preserved.txt'],seed);await git(['commit','-m','Initial synthetic commit'],seed);await git(['remote','add','origin',remote],seed);await git(['push','origin','main'],seed);await git(['symbolic-ref','HEAD','refs/heads/main'],remote);
 await fs.writeFile(path.join(source,'result.txt'),'published result');await fs.writeFile(path.join(source,'private-note.txt'),'never selected');
 const repository='https://github.com/synthetic/agent-space-publisher-test';const rewrite=pathToFileURL(remote).href;
 const publisher=new Publisher(path.join(root,'publisher'),{env:{...env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'url.'+rewrite+'.insteadOf',GIT_CONFIG_VALUE_0:repository}});
 const result=await publisher.publish({id:'test',root:source,repository},{paths:['result.txt'],message:'Publish synthetic result'});
 assert.equal(result.published,true);assert.match(result.commit,/^[a-f0-9]{40}$/);assert.equal(await git(['show','main:result.txt'],remote),'published result');assert.equal(await git(['show','main:preserved.txt'],remote),'remote only');
 assert.equal(await fs.readFile(path.join(source,'private-note.txt'),'utf8'),'never selected');assert.equal((await git(['ls-tree','-r','--name-only','main'],remote)).includes('private-note'),false);
 assert.equal((await publisher.publish({id:'test',root:source,repository},{paths:['result.txt'],message:'No changes'})).published,false);
 await assert.rejects(()=>publisher.publish({id:'test',root:source,repository},{paths:['../seed/preserved.txt'],message:'Forbidden'}),/outside/);
});
test('preview reads generated graphs and code without executing them and rejects escapes and oversized files',async()=>{
 const root=await fixture();await fs.writeFile(path.join(root,'script.py'),'print("preview only")');await fs.writeFile(path.join(root,'graph.svg'),'<svg xmlns="http://www.w3.org/2000/svg"></svg>');
 assert.equal((await previewFile({root},'script.py')).kind,'text');assert.equal((await previewFile({root},'graph.svg')).type,'image/svg+xml');await assert.rejects(()=>previewFile({root},'../elsewhere.py'),/outside/);
 await fs.writeFile(path.join(root,'large.txt'),Buffer.alloc(8000001));await assert.rejects(()=>previewFile({root},'large.txt'),/8 MB/);
});
test('model parser supports OBJ and binary/ASCII STL and rejects invalid geometry',()=>{
 const bytes=s=>new TextEncoder().encode(s).buffer;const obj=parseModel(bytes('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3'),'triangle.obj');assert.equal(obj.faces.length,1);
 assert.equal(parseModel(bytes('solid a\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid'),'triangle.stl').faces.length,1);
 const binary=new ArrayBuffer(134),view=new DataView(binary);view.setUint32(80,1,true);view.setFloat32(108,1,true);view.setFloat32(124,1,true);assert.equal(parseModel(binary,'triangle.stl').faces.length,1);
 assert.throws(()=>parseModel(bytes('v 0 0 0\nf 1 2 3'),'bad.obj'),/valid/);assert.deepEqual(parseCsv('name,value\n"a,b",3\n'),[['name','value'],['a,b','3']]);
});
