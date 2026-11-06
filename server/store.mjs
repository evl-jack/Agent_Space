import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { canonicalFolder, githubRepo, inside } from './policy.mjs';

export class Store {
  constructor(folder) { this.folder = folder; this.queue = Promise.resolve(); }
  async open() {
    await fs.mkdir(this.folder, { recursive: true });
    try { this.data = JSON.parse(await fs.readFile(path.join(this.folder, 'state.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.data = { version: 1, projects: [], events: [], messages: [], tasks: [] }; }
    this.data.settings={taskLimitsEnabled:true,folderMode:'approved',...this.data.settings};
    for (const p of this.data.projects) {
      p.names = { lead: 'Lead', runner: 'Runner', reporter: 'Reporter', ...p.names };
      p.efforts = { lead: 'high', runner: 'low', reporter: 'low', ...p.efforts };
      p.spaces ||= [];
    }
    for (const t of this.data.tasks) if (['running','queued'].includes(t.status)) t.status = 'interrupted';
    return this;
  }
  save() {
    const value = JSON.stringify(this.data, null, 2);
    this.queue = this.queue.then(async () => {
      const target = path.join(this.folder, 'state.json');
      await fs.writeFile(`${target}.tmp`, value, { mode: 0o600 });
      await fs.rename(`${target}.tmp`, target);
    });
    return this.queue;
  }
  project(id) { const p = this.data.projects.find(p => p.id === id); if (!p) throw new Error('Select an existing project.'); return p; }
  async addProject(input) {
    const root = await canonicalFolder(input.root);
    if(inside(this.folder,root)||inside(path.join(os.homedir(),'.codex'),root))throw new Error('Choose a project folder outside application records and credential storage.');
    if (this.data.projects.some(p => p.root.toLowerCase() === root.toLowerCase())) throw new Error('This folder already has a project.');
    const p = { id: randomUUID(), name: String(input.name || path.basename(root)).slice(0,80), root, repository: githubRepo(input.repository), brief: '', sourceThreadId: null, names: { lead: 'Lead', runner: 'Runner', reporter: 'Reporter' }, models: { lead: 'gpt-6.1-sol', runner: 'gpt-6-luna', reporter: 'gpt-6-luna' }, limits: { tokens: 20000, minutes: 15, delegations: 3 }, createdAt: new Date().toISOString() };
    p.efforts = { lead: 'high', runner: 'low', reporter: 'low' };
    p.spaces = [];
    this.data.projects.push(p); await this.save(); return p;
  }
  event(projectId, role, kind, text, extra = {}) {
    const event = { id: randomUUID(), projectId, role, kind, text: String(text).slice(0,12000), at: new Date().toISOString(), ...extra };
    this.data.events.push(event); this.data.events = this.data.events.slice(-1200); this.save(); return event;
  }
  message(projectId, role, text, taskId) {
    const message = { id: randomUUID(), projectId, role, text: String(text).slice(0,24000), taskId, at: new Date().toISOString() };
    this.data.messages.push(message); this.data.messages = this.data.messages.slice(-500); this.save(); return message;
  }
  snapshot() { return structuredClone(this.data); }
}
