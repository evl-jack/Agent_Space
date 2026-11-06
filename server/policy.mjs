import fs from 'node:fs/promises';
import path from 'node:path';

export const protectedParts = new Set(['.git', '.codex', '.agents', '.aws', '.ssh', '.local', 'node_modules', '.venv']);
export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export async function canonicalFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Choose an absolute project folder.');
  const root = await fs.realpath(folder);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('The project folder must be a directory.');
  if (root === path.parse(root).root) throw new Error('Select a project folder, not an entire drive.');
  return root;
}
export async function resolveProjectPath(root, relative, { write = false } = {}) {
  if (typeof relative !== 'string' || relative.length > 1500 || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('Use a path relative to the selected project.');
  const parts = relative.replaceAll('\\', '/').split('/').filter(Boolean);
  if (parts.some(p => p === '..' || p.includes(':') || protectedParts.has(p.toLowerCase()))) throw new Error('That path is outside the permitted project files.');
  if (parts.some(p => (p!=='.' && /[. ]$/.test(p)) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Use a normal project filename without device names or trailing dots and spaces.');
  const realRoot = await fs.realpath(root);
  if (realRoot.toLowerCase() !== root.toLowerCase()) throw new Error('The approved project folder has moved or become a linked path. Review its boundary first.');
  if (write && parts.some(p => /^\.env(?:\.|$)/i.test(p))) throw new Error('Credential files require a separate permission review.');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Linked paths require a separate permission review.');
      const real = await fs.realpath(current);
      if (!inside(root, real)) throw new Error('The path leaves the selected project.');
    } catch (error) {
      if (error.code !== 'ENOENT' || !write) throw error;
    }
  }
  if (!inside(root, current)) throw new Error('The path leaves the selected project.');
  return current;
}
export async function readProjectFile(root, relative) {
  const target = await resolveProjectPath(root, relative);
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size > 160_000) throw new Error('Choose a text file smaller than 160 KB.');
  if (/\.env(?:\.|$)/i.test(path.basename(target))) throw new Error('Credential files require a separate permission review.');
  const text = await fs.readFile(target, 'utf8');
  if (text.includes('\0')) throw new Error('This file is not plain text.');
  return text;
}
export async function listProjectFiles(root, relative = '') {
  const target = await resolveProjectPath(root, relative);
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries.filter(e => !e.isSymbolicLink() && !protectedParts.has(e.name.toLowerCase()) && !/^\.env(?:\.|$)/i.test(e.name))
    .sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 100).map(e => ({ name: e.name, directory: e.isDirectory() }));
}
export function githubRepo(value) {
  if (!value) return null;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(value);
  if (!match) throw new Error('Use a GitHub repository URL without credentials or extra paths.');
  return `https://github.com/${match[1]}/${match[2]}`;
}
export function profileDefinitions(project, toolRoots = []) {
  const readable = { ':root': 'deny', ':minimal': 'read', [project.root]: 'read' };
  for (const folder of toolRoots) readable[folder] = 'read';
  for (const name of ['.git', '.codex', '.agents', '.aws', '.ssh', '.local', '.env']) readable[path.join(project.root, name)] = 'deny';
  const writer = { ...readable, [project.root]: 'write' };
  for (const name of ['.git', '.codex', '.agents', '.aws', '.ssh', '.local']) writer[path.join(project.root, name)] = 'deny';
  return {
    space_read: { description: 'Read the selected project only', filesystem: readable, network: { enabled: false } },
    space_execute: { description: 'Execute within the selected project; no network or repository metadata changes', filesystem: writer, network: { enabled: false } }
  };
}
// These are config overrides for one child process. They never edit config.toml.
export function profileArguments(project, toolRoots) {
  const entries = profileDefinitions(project, toolRoots);
  const table = obj => `{${Object.entries(obj).map(([k,v]) => `${JSON.stringify(k)}=${typeof v === 'object' ? table(v) : JSON.stringify(v)}`).join(',')}}`;
  return ['-c', `permissions=${table(entries)}`, '-c', 'default_permissions="space_read"', '-c', 'windows.sandbox="mxc"'];
}
