import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { canonicalFolder, inside, protectedParts } from './policy.mjs';

export class Spaces {
  constructor(store) { this.store=store;this.temporary=[];this.forbidden=[store.folder,path.join(os.homedir(),'.codex')]; }
  main(project) { return {id:'main',root:project.root,label:'Main project',access:'write',duration:'project',primary:true}; }
  list(projectId) { const p=this.store.project(projectId);return [this.main(p),...(p.spaces||[]),...this.temporary.filter(g=>g.projectId===projectId)]; }
  forTask(projectId,taskId) { return this.list(projectId).filter(g=>g.duration!=='task'||(taskId&&g.taskId===taskId)); }
  bindNext(projectId,taskId,role) { if(role==='lead')for(const g of this.temporary)if(g.projectId===projectId&&g.duration==='task'&&!g.taskId)g.taskId=taskId; }
  finish(projectId,taskId) {
    const expired=this.temporary.filter(g=>g.projectId===projectId&&g.duration==='task'&&g.taskId===taskId);
    this.temporary=this.temporary.filter(g=>!expired.includes(g));return expired;
  }
  async add(projectId,input) {
    if(!['read','write'].includes(input.access))throw new Error('Choose read-only or read/write access.');
    if(!['task','session','project'].includes(input.duration))throw new Error('Choose task, session, or project duration.');
    const root=await canonicalFolder(input.root);
    if(protectedParts.has(path.basename(root).toLowerCase())||this.forbidden.some(p=>inside(p,root)))throw new Error('Application records and credential folders cannot be approved as agent spaces.');
    if(this.list(projectId).some(g=>inside(g.root,root)||inside(root,g.root)))throw new Error('Choose a separate folder. This folder overlaps an already approved space.');
    const grant={id:randomUUID(),projectId,root,label:path.basename(root),access:input.access,duration:input.duration,taskId:input.duration==='task'?(input.taskId||null):null,approvedAt:new Date().toISOString()};
    if(input.duration==='project')this.store.project(projectId).spaces.push(grant);else this.temporary.push(grant);
    await this.store.save();return grant;
  }
  async remove(projectId,id) {
    if(id==='main')throw new Error('The main workspace cannot be removed here.');
    const p=this.store.project(projectId);p.spaces=(p.spaces||[]).filter(g=>g.id!==id);
    this.temporary=this.temporary.filter(g=>!(g.projectId===projectId&&g.id===id));await this.store.save();
  }
}
