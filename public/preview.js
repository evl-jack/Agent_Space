export function parseModel(buffer,name){
  const points=[],faces=[];
  if(/\.obj$/i.test(name)){
    const source=new TextDecoder().decode(buffer);
    for(const line of source.split(/\r?\n/)){
      const fields=line.trim().split(/\s+/);
      if(fields[0]==='v')points.push(fields.slice(1,4).map(Number));
      if(fields[0]==='f'){
        const indices=fields.slice(1).map(v=>Number(v.split('/')[0])).map(v=>v<0?points.length+v:v-1);
        for(let i=1;i<indices.length-1;i++)faces.push([indices[0],indices[i],indices[i+1]]);
      }
    }
  }else{
    const data=new DataView(buffer);const count=buffer.byteLength>=84?data.getUint32(80,true):0;
    if(count>0&&84+count*50===buffer.byteLength){
      if(count>100000)throw new Error('Choose a model with at most 100,000 triangles.');
      for(let i=0;i<count;i++){
        const indices=[];for(let v=0;v<3;v++){indices.push(points.length);const at=84+i*50+12+v*12;points.push([0,4,8].map(n=>data.getFloat32(at+n,true)));}faces.push(indices);
      }
    }else{
      const source=new TextDecoder().decode(buffer);let tri=[];
      for(const match of source.matchAll(/\bvertex\s+([\deE+.-]+)\s+([\deE+.-]+)\s+([\deE+.-]+)/g)){
        tri.push(points.length);points.push(match.slice(1).map(Number));if(tri.length===3){faces.push(tri);tri=[];}
      }
    }
  }
  if(!points.length||!faces.length||points.length>300000||faces.length>100000||points.some(p=>p.length!==3||p.some(n=>!Number.isFinite(n)))||faces.some(f=>f.some(i=>!Number.isInteger(i)||i<0||i>=points.length)))throw new Error('Choose a valid OBJ/STL triangle model with at most 100,000 triangles.');
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(const p of points)for(let i=0;i<3;i++){min[i]=Math.min(min[i],p[i]);max[i]=Math.max(max[i],p[i]);}
  const center=min.map((n,i)=>(n+max[i])/2);const size=Math.max(...max.map((n,i)=>n-min[i]));if(!Number.isFinite(size)||size<=0)throw new Error('The model has no visible dimensions.');
  return {points:points.map(p=>p.map((n,i)=>(n-center[i])/size)),faces};
}
export function parseCsv(source){
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<source.length;i++){
    const c=source[i];if(c==='"'){if(quoted&&source[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(c===','&&!quoted){row.push(cell);cell='';}
    else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';if(rows.length>=100)return rows;}
    else cell+=c;
  }
  if(cell||row.length){row.push(cell);rows.push(row);}return rows;
}
function modelCanvas(container,model){
  const canvas=document.createElement('canvas');canvas.setAttribute('aria-label','3D model preview. Drag to rotate; scroll to zoom.');canvas.tabIndex=0;container.append(canvas);
  const note=document.createElement('p');note.className='preview-model-note';note.textContent=`${model.faces.length.toLocaleString()} triangles · drag to rotate · scroll to zoom · arrow keys rotate`;container.append(note);
  let yaw=.5,pitch=-.4,zoom=1,drag=null;
  function draw(){
    const w=Math.max(200,canvas.clientWidth),h=330,dpr=Math.min(devicePixelRatio||1,2);canvas.width=w*dpr;canvas.height=h*dpr;const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);
    const a=Math.cos(yaw),b=Math.sin(yaw),c=Math.cos(pitch),d=Math.sin(pitch),scale=Math.min(w,h)*.72*zoom;
    const projected=model.points.map(([x,y,z])=>{const xx=a*x+b*z,zz=-b*x+a*z;return [w/2+xx*scale,h/2-(c*y-d*zz)*scale,d*y+c*zz];});
    ctx.strokeStyle='#4e8877';ctx.lineWidth=.6;const step=Math.max(1,Math.ceil(model.faces.length/16000));ctx.beginPath();
    for(let i=0;i<model.faces.length;i+=step){const f=model.faces[i],p=f.map(n=>projected[n]);ctx.moveTo(p[0][0],p[0][1]);ctx.lineTo(p[1][0],p[1][1]);ctx.lineTo(p[2][0],p[2][1]);ctx.lineTo(p[0][0],p[0][1]);}ctx.stroke();
  }
  canvas.onpointerdown=e=>{drag=[e.clientX,e.clientY];canvas.setPointerCapture(e.pointerId);};canvas.onpointerup=canvas.onpointercancel=()=>drag=null;
  canvas.onpointermove=e=>{if(!drag)return;yaw+=(e.clientX-drag[0])*.01;pitch+=(e.clientY-drag[1])*.01;drag=[e.clientX,e.clientY];draw();};
  canvas.onwheel=e=>{e.preventDefault();zoom=Math.min(4,Math.max(.2,zoom*Math.exp(-e.deltaY*.001)));draw();};
  canvas.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();yaw+=e.key==='ArrowLeft'?-.15:e.key==='ArrowRight'?.15:0;pitch+=e.key==='ArrowUp'?-.15:e.key==='ArrowDown'?.15:0;draw();};
  requestAnimationFrame(draw);
}
export function setupPreview({api,current,toast}){
  const el=id=>document.getElementById(id);let projectId=null,folder='',version=0,blobUrl=null;
  const revoke=()=>{if(blobUrl){URL.revokeObjectURL(blobUrl);blobUrl=null;}};
  function sync(){if(projectId===current()?.id)return;projectId=current()?.id;version++;folder='';revoke();el('preview-path').value='';el('preview-files').replaceChildren();el('preview-content').textContent='Open a file or folder to preview this project’s outputs.';el('preview-caption').textContent='No file selected';}
  async function open(file){
    const project=current();if(!project){toast('Choose a project first.');return;}const stamp=++version;
    try{
      const response=await fetch(`/api/preview?${new URLSearchParams({projectId:project.id,path:file})}`);if(!response.ok){const error=await response.json();throw new Error(error.error);}
      const kind=response.headers.get('X-Preview-Kind'),bytes=await response.arrayBuffer();if(stamp!==version)return;revoke();const content=el('preview-content');content.replaceChildren();el('preview-caption').textContent=file;el('preview-path').value=file;
      if(kind==='image'){blobUrl=URL.createObjectURL(new Blob([bytes],{type:response.headers.get('Content-Type')}));const img=document.createElement('img');img.src=blobUrl;img.alt=file;content.append(img);}
      else if(kind==='model')modelCanvas(content,parseModel(bytes,file));
      else if(/\.csv$/i.test(file)){const table=document.createElement('table');for(const row of parseCsv(new TextDecoder().decode(bytes))){const tr=document.createElement('tr');for(const value of row){const td=document.createElement('td');td.textContent=value;tr.append(td);}table.append(tr);}content.append(table);const note=document.createElement('p');note.textContent='Showing up to 100 rows.';content.append(note);}
      else{const pre=document.createElement('pre');pre.textContent=new TextDecoder().decode(bytes);content.append(pre);}
    }catch(e){if(stamp===version){el('preview-content').textContent=e.message;toast(e.message);}}
  }
  async function browse(value){
    const project=current();if(!project){toast('Choose a project first.');return;}const stamp=++version;
    try{const entries=await api(`/api/files?${new URLSearchParams({projectId:project.id,path:value})}`);if(stamp!==version)return;folder=value.replace(/[\\/]$/,'');el('preview-path').value=folder;el('preview-files').replaceChildren();
      for(const entry of entries){const button=document.createElement('button');button.type='button';button.className='preview-file';button.textContent=(entry.directory?'▸ ':'')+entry.name;const file=(folder?folder+'/':'')+entry.name;button.onclick=()=>entry.directory?browse(file):open(file);el('preview-files').append(button);}
      if(!entries.length)el('preview-files').textContent='This folder is empty.';
    }catch{if(stamp===version)await open(value);}
  }
  el('preview-form').onsubmit=e=>{e.preventDefault();browse(el('preview-path').value.trim());};
  el('preview-up').onclick=()=>{const parts=folder.replaceAll('\\','/').split('/');parts.pop();browse(parts.join('/'));};
  return {sync};
}
