import fs from 'node:fs/promises';
import path from 'node:path';
import {resolveProjectPath,inside} from './policy.mjs';

const images={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml'};
const text=new Set(['.txt','.md','.py','.js','.mjs','.ts','.tsx','.jsx','.json','.csv','.css','.html','.xml','.yaml','.yml','.toml','.c','.cpp','.h','.rs','.sh','.ps1','.log','.obj']);
export async function previewFile(project,relative,{computer=false,forbidden=[]}={}){
  const target=await resolveProjectPath(project.root,relative,{computer});
  if(!computer&&forbidden.some(folder=>inside(folder,target)))throw new Error('That preview path is protected.');
  const ext=path.extname(target).toLowerCase();const kind=images[ext]?'image':['.obj','.stl'].includes(ext)?'model':text.has(ext)?'text':null;
  if(!kind)throw new Error('Preview supports code/text, CSV, images, SVG graphs, and OBJ/STL models.');
  if(/^\.env(?:\.|$)/i.test(path.basename(target)))throw new Error('Credential files cannot be previewed.');
  const stat=await fs.stat(target);if(!stat.isFile()||stat.size>8000000)throw new Error('Choose a preview file smaller than 8 MB.');
  const data=await fs.readFile(target);
  if(kind==='text'&&data.includes(0))throw new Error('This file is not plain text.');
  return {data,kind,name:path.basename(target),type:images[ext]||'application/octet-stream'};
}
