import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

export function findCodex({env=process.env,lookup=execFileSync}={}) {
  if (env.CODEX_PATH && fs.existsSync(env.CODEX_PATH)) return env.CODEX_PATH;
  try {
    const candidates = lookup(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
    const candidate=candidates.find(p=>/\.exe$/i.test(p))||(process.platform!=='win32'?candidates[0]:null);
    if(candidate)return candidate;
  } catch {}
  // Explorer-launched apps do not inherit the PATH additions from a Codex chat.
  // Discover only the desktop app's known installation directory, never auth data.
  if(env.LOCALAPPDATA){
    const bin=path.join(env.LOCALAPPDATA,'OpenAI','Codex','bin');
    try{
      const candidates=[path.join(bin,'codex.exe'),...fs.readdirSync(bin,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>path.join(bin,e.name,'codex.exe'))]
        .filter(p=>fs.existsSync(p)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
      if(candidates.length)return candidates[0];
    }catch{}
  }
  throw new Error('Codex was not found. Install the Codex desktop app or set CODEX_PATH to its codex.exe.');
}
export class CodexClient extends EventEmitter {
  constructor({ args = [], executable, spawnProcess = spawn } = {}) { super(); this.args = args; this.executable = executable; this.spawnProcess = spawnProcess; this.pending = new Map(); this.sequence = 0; this.closed = false; }
  async open() {
    this.child = this.spawnProcess(this.executable || findCodex(), ['app-server','--stdio', ...this.args], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => { try { this.receive(JSON.parse(line)); } catch { this.emit('diagnostic', 'Ignored a malformed server message.'); } });
    this.child.stderr.on('data', data => this.emit('diagnostic', String(data).replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,1500)));
    this.child.on('error', e => this.fail(e));
    this.child.on('exit', code => this.fail(new Error(`The local Codex connection closed (${code ?? 'stopped'}).`)));
    await this.request('initialize', { clientInfo: { name: 'agent_space_local', title: 'Agent Space', version: '0.2.5' }, capabilities: { experimentalApi: true } });
    this.notify('initialized'); return this;
  }
  receive(message) {
    if (message.method && message.id !== undefined) { this.emit('request', message); return; }
    if (message.method) { this.emit('notification', message.method, message.params || {}); return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(message.id);
    message.error ? pending.reject(new Error(message.error.message || 'Codex rejected the request.')) : pending.resolve(message.result);
  }
  request(method, params = {}, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error('The local Codex connection is closed.'));
    return new Promise((resolve,reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} did not respond in time.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  notify(method, params) { if (!this.closed) this.child.stdin.write(JSON.stringify({ method, ...(params ? { params } : {}) }) + '\n'); }
  respond(id, result, error) { if (!this.closed) this.child.stdin.write(JSON.stringify(error ? {id,error:{code:-32000,message:String(error)}} : {id,result}) + '\n'); }
  fail(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit('closed', error);
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.fail(new Error('Connection stopped.')); this.lines?.close();
    if (this.child?.pid) {
      if (process.platform === 'win32') await new Promise(resolve => {
        const killer = spawn('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', resolve); killer.on('exit', resolve);
      }); else this.child.kill('SIGTERM');
    }
  }
}
export async function inspectConnection() {
  const client = new CodexClient();
  try {
    await client.open();
    const account = await client.request('account/read', { refreshToken: false });
    const models = await client.request('model/list', { limit: 50, includeHidden: false });
    const readiness = await client.request('windowsSandbox/readiness');
    return { connected: !!account.account, accountType: account.account?.type, plan: account.account?.planType, models: (models.data || []).map(m => ({ id: m.model, name: m.displayName, description: m.description, efforts: m.supportedReasoningEfforts?.map(e => e.reasoningEffort) || [] })), isolation: readiness.status, checkedAt: new Date().toISOString() };
  } finally { await client.close(); }
}
