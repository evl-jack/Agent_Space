import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {githubRepo,resolveProjectPath} from './policy.mjs';

const execute=promisify(execFile);
export class Publisher {
  constructor(folder,{env=process.env}={}){this.folder=folder;this.env=env;this.busy=new Set();}
  async git(args,cwd,signal){
    try{return (await execute('git',['-c','core.longpaths=true','-c',`core.hooksPath=${path.join(this.folder,'empty-hooks')}`,'-c','commit.gpgsign=false',...args],{cwd,signal,windowsHide:true,timeout:60000,maxBuffer:1000000,env:{...this.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}})).stdout.trim();}
    catch(e){throw new Error(`Git ${args[0]} failed: ${String(e.stderr||e.message).replace(/https:\/\/[^\s/@]+@/g,'https://[redacted]@').slice(-3000)}`);}
  }
  async publish(project,{paths,message},signal){
    const repository=githubRepo(project.repository);if(!repository)throw new Error('Set this project’s GitHub repository in Project settings first.');
    if(!Array.isArray(paths)||!paths.length||paths.length>50||paths.some(p=>typeof p!=='string'||!p||p.startsWith('-')))throw new Error('Select 1–50 explicit files relative to the project folder.');
    if(typeof message!=='string'||!message.trim()||message.length>300)throw new Error('Provide a short commit message.');
    if(this.busy.has(project.id))throw new Error('A publish is already running for this project.');
    this.busy.add(project.id);
    try{
      const git=(args,cwd)=>this.git(args,cwd,signal);
      const files=[];let total=0;
      for(const name of [...new Set(paths)]){
        const target=await resolveProjectPath(project.root,name);const stat=await fs.stat(target);
        if(!stat.isFile()||stat.size>8000000||(total+=stat.size)>25000000)throw new Error('Publish ordinary project files, up to 8 MB each and 25 MB per request.');
        if(/(^|[\\/])(?:\.env(?:\.|$)|credentials(?:\.|$)|id_(?:rsa|ed25519)(?:\.|$))/i.test(name))throw new Error('Credential files cannot be published.');
        files.push({name:path.relative(project.root,target),data:await fs.readFile(target)});
      }
      if(signal?.aborted)throw new Error('Publishing stopped.');
      await fs.mkdir(this.folder,{recursive:true});await fs.mkdir(path.join(this.folder,'empty-hooks'),{recursive:true});
      const checkout=await fs.mkdtemp(path.join(this.folder,'publish-'));
      // An isolated checkout preserves the source folder, unrelated work, and the remote’s other files.
      await git(['clone','--depth','1','--',repository,checkout],this.folder);
      for(const file of files){
        if(signal?.aborted)throw new Error('Publishing stopped.');
        const destination=await resolveProjectPath(checkout,file.name,{write:true});await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,file.data);
      }
      const names=files.map(f=>f.name);await git(['add','--',...names],checkout);
      const diff=await git(['diff','--cached','--name-only'],checkout);
      if(!diff)return {published:false,reason:'Selected files already match GitHub.',repository,files:names};
      if(signal?.aborted)throw new Error('Publishing stopped before commit.');
      await git(['commit','-m',message.trim()],checkout);
      const commit=await git(['rev-parse','HEAD'],checkout);
      if(signal?.aborted)throw new Error('Publishing stopped before push.');
      await git(['push','origin','HEAD'],checkout);
      return {published:true,repository,commit,url:`${repository}/commit/${commit}`,files:diff.split(/\r?\n/)};
    }finally{this.busy.delete(project.id);}
  }
}
