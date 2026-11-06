const $=selector=>document.querySelector(selector);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state=null;let activeId=localStorage.getItem('agent-space-project');let csrf=sessionStorage.getItem('agent-space-csrf');let refreshTimer;let toastTimer;
const current=()=>state?.projects.find(p=>p.id===activeId);
const agentName=(role,project=current())=>project?.names?.[role]||({lead:'Lead',runner:'Runner',reporter:'Reporter'}[role])||role;
const effortLabels={none:'None',minimal:'Minimal',low:'Light · low',medium:'Balanced · medium',high:'Deep · high',xhigh:'Extra deep',max:'Maximum',ultra:'Ultra'};
const savedEffort=role=>current()?.efforts?.[role]||(role==='lead'?'high':'low');
function fillEffortOptions(role,preferred){
  const model=state.connection.models.find(m=>m.id===$(`#setting-${role}`).value);
  const choices=model?.efforts?.length?model.efforts:[preferred];
  const select=$(`#setting-${role}-effort`);select.innerHTML=choices.map(value=>`<option value="${escape(value)}">${escape(effortLabels[value]||value)}</option>`).join('');
  select.value=choices.includes(preferred)?preferred:choices[0];select.disabled=!state.connection.connected||!model?.efforts?.length;
}
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,6500);}
async function api(url,options={}){
  const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(csrf?{'X-Agent-Space-Token':csrf}:{}),...options.headers},...(options.body&&typeof options.body!=='string'?{body:JSON.stringify(options.body)}:{})});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'This action could not be completed.');return data;
}
async function reload(){state=await api('/api/state');if(!state.projects.some(p=>p.id===activeId))activeId=state.projects[0]?.id;render();}
function scheduleReload(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>reload().catch(e=>toast(e.message)),100);}
const time=value=>new Date(value).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
function render(){
  const project=current();
  for(const role of ['lead','runner','reporter']){$(`#${role}-name`).textContent=agentName(role,project);$(`#${role}-avatar`).textContent=[...agentName(role,project)][0].toUpperCase();}
  $('#lead-heading').textContent=agentName('lead')==='Lead'?'Work with your Lead':`Work with ${agentName('lead')}`;
  $('#reporter-heading').textContent=agentName('reporter')==='Reporter'?'Ask your Reporter':`Ask ${agentName('reporter')}`;
  $('#lead-submit').innerHTML=`Give task to ${escape(agentName('lead'))} <span>↗</span>`;
  $('#project-list').innerHTML=state.projects.map((p,i)=>`<button class="project-button ${p.id===activeId?'active':''}" data-project="${escape(p.id)}"><span class="project-symbol">${i===0?'◈':'⌘'}</span><span><strong>${escape(p.name)}</strong><small>${escape(p.sourceThreadId?'Existing project':'Local workspace')}</small></span></button>`).join('');
  $('#project-title').textContent=project?.name||'A space for your next project';$('#breadcrumb-project').textContent=project?.name||'New project';
  $('#project-folder').textContent=project?.root||'Add an approved project folder to begin';$('#project-folder').title=project?.root||'';
  const repo=$('#project-repository');repo.textContent=project?.repository?project.repository.replace('https://github.com/',''):'Not connected';if(project?.repository)repo.href=project.repository;else repo.removeAttribute('href');
  $('#project-description').textContent=project?.sourceThreadId?'Continue your existing work with a focused team and a separate project history.':'One Lead for the hard thinking. A Runner for the work. A Reporter when you ask.';
  const connection=state.connection;$('#connection-badge').textContent=connection.connected?`Codex · ${connection.plan||'Connected'}`:'Not checked';$('#connection-badge').classList.toggle('connected',!!connection.connected);
  $('#check-connection').textContent=connection.connected?'Check connection':'Check connection';
  $('#live-toggle').textContent=state.liveEnabled?'Pause live tasks':'Enable live tasks';$('#live-toggle').classList.toggle('enabled',state.liveEnabled);
  $('#task-mode-note').innerHTML=state.liveEnabled?'<i class="pause-dot"></i> Uses your Codex allowance':'<i class="pause-dot"></i> Live tasks are paused';
  const tasks=state.tasks.filter(t=>t.projectId===activeId);const working=tasks.filter(t=>t.status==='running');
  $('#stop-all').disabled=working.length===0;$('#lead-status').textContent=working.some(t=>t.role==='lead')?'Working':'Ready';$('#lead-status').classList.toggle('busy',working.some(t=>t.role==='lead'));
  $('#reporter-status').textContent=working.some(t=>t.role==='reporter')?'Answering':'Quiet';$('#reporter-status').classList.toggle('busy',working.some(t=>t.role==='reporter'));
  $('#runner-status').textContent=working.some(t=>t.role==='lead'&&t.delegations>0)?'On task':'Waiting';
  $('#lead-model').textContent=project?`${project.models.lead} · ${effortLabels[savedEffort('lead')]||savedEffort('lead')}`:'Strong reasoning';
  const messages=state.messages.filter(m=>m.projectId===activeId);
  const messageHtml=m=>`<article class="message ${m.role.startsWith('user')?'user':escape(m.role)}"><div class="message-header"><span>${m.role.startsWith('user')?'YOU':escape(agentName(m.role).toUpperCase())}</span><time>${time(m.at)}</time></div><div class="message-text">${escape(m.text)}</div></article>`;
  const leadMessages=messages.filter(m=>['lead','runner','user-lead'].includes(m.role));
  $('#lead-messages').innerHTML=leadMessages.length?leadMessages.map(messageHtml).join(''):'<div class="empty-lead"><div class="empty-art">⌘</div><h3>Make room for the hard thinking.</h3><p>Give your Lead a goal. It will plan the approach, direct the Runner, and review what comes back.</p><div class="flow-hint"><strong>You</strong><span>→</span><strong>Lead</strong><span>→</span><strong>Runner</strong></div></div>';
  const reportMessages=messages.filter(m=>['reporter','user-reporter'].includes(m.role));
  $('#reporter-messages').innerHTML=reportMessages.length?reportMessages.map(messageHtml).join(''):'<p class="empty-reporter">An independent view of your project.<br>Ask for progress, decisions, or a recap.<br>Your Reporter stays quiet until you ask.</p>';
  const events=state.events.filter(e=>e.projectId===activeId).slice(-70).reverse();$('#activity-count').textContent=events.length;
  $('#activity-list').innerHTML=events.length?events.map(e=>`<article class="activity-entry ${escape(e.kind)}"><div class="activity-meta"><strong>${escape(agentName(e.role).toUpperCase())} · ${escape(e.kind)}</strong><time>${time(e.at)}</time></div><div class="activity-text">${escape(e.text)}</div>${e.backupId?`<button class="text-button" data-restore="${escape(e.backupId)}">Restore this file checkpoint ↶</button>`:''}</article>`).join(''):'<div class="empty-activity"><strong>Ready when you are</strong><p>Plans, file changes, and test results will appear here. This project’s record stays separate from your other work.</p></div>';
  const tokens=tasks.reduce((sum,t)=>sum+(t.tokens||0),0);$('#usage-text').textContent=tasks.length?`${tokens.toLocaleString()} observed tokens · ${tasks.length} task${tasks.length===1?'':'s'} · Exact credits unavailable`:'No model tasks run in this project';
  $('#limit-label').textContent=project?`${(project.limits.tokens/1000).toLocaleString()}k tokens · ${project.limits.minutes} min`:'';
  for(const form of ['lead','reporter']){$(`#${form}-form button`).disabled=!project||working.some(t=>t.role===form);}
  $('#project-settings').disabled=!project;
  $('#spaces-button').disabled=!project;$('#spaces-count').textContent=project?.approvedSpaces?.length||1;renderSpaces();
}
function renderSpaces(){
  const p=current();if(!p)return;
  const spaces=p.approvedSpaces||[{id:'main',root:p.root,label:'Main project',access:'write',duration:'project',primary:true}];
  $('#spaces-list').innerHTML=spaces.map(g=>{
    const duration=g.duration==='project'?'Saved for this project':g.duration==='session'?'Until the app stops':g.taskId?'Until the selected task finishes':'Next Lead task only';
    return `<div class="space-item"><div><strong>${escape(g.label)}${g.primary?' · primary':''}</strong><code>${escape(g.root)}</code><small>${g.access==='write'?'Read/write':'Read-only'} · ${escape(duration)}</small></div>${g.primary?'':`<button type="button" class="button button-small space-revoke" data-revoke="${escape(g.id)}">Remove access</button>`}</div>`;
  }).join('');
  const selected=$('#space-task-target').value;
  const tasks=state.tasks.filter(t=>t.projectId===p.id&&t.status==='running');
  $('#space-task-target').innerHTML='<option value="">Next Lead task</option>'+tasks.map(t=>`<option value="${escape(t.id)}">Current ${escape(agentName(t.role))} task</option>`).join('');
  if(tasks.some(t=>t.id===selected))$('#space-task-target').value=selected;
}
async function updateGit(){const project=current();if(!project)return;$('#git-status').textContent='';try{const git=await api(`/api/projects/${project.id}/git`);if(current()?.id===project.id)$('#git-status').textContent=git.connected?`${git.branch||'No branch'} · ${git.changes} changed`:'Local folder not linked to Git';}catch{}}
$('#project-list').addEventListener('click',e=>{const button=e.target.closest('[data-project]');if(!button)return;activeId=button.dataset.project;localStorage.setItem('agent-space-project',activeId);render();updateGit();});
$('#add-project').onclick=()=>$('#add-dialog').showModal();
$('#add-form').onsubmit=async e=>{e.preventDefault();try{const data=Object.fromEntries(new FormData(e.currentTarget));const project=await api('/api/projects',{method:'POST',body:data});activeId=project.id;localStorage.setItem('agent-space-project',activeId);$('#add-dialog').close();e.target.reset();await reload();updateGit();toast('Project added. Its context starts here.');}catch(error){toast(error.message);}};
for(const button of document.querySelectorAll('.close-dialog'))button.onclick=()=>button.closest('dialog').close();
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
function openSettings(){
  const p=current();if(!p)return;$('#setting-name').value=p.name;$('#setting-repository').value=p.repository||'';$('#setting-brief').value=p.brief||'';$('#setting-tokens').value=p.limits.tokens;$('#setting-minutes').value=p.limits.minutes;$('#setting-delegations').value=p.limits.delegations;$('#setting-source').value=p.sourceThreadId||'';$('#setting-source-mode').value=p.sourceMode||'handoff';
  for(const role of ['lead','runner','reporter'])$(`#setting-${role}-name`).value=agentName(role,p);
  for(const role of ['lead','runner','reporter']){const models=state.connection.models.length?state.connection.models:[{id:p.models[role],name:p.models[role]}];$(`#setting-${role}`).innerHTML=models.map(m=>`<option value="${escape(m.id)}">${escape(m.name)}</option>`).join('');$(`#setting-${role}`).value=p.models[role];}
  for(const role of ['lead','runner','reporter']){fillEffortOptions(role,savedEffort(role));$(`#setting-${role}`).onchange=()=>fillEffortOptions(role,$(`#setting-${role}-effort`).value);}
  $('#settings-dialog').showModal();
}
$('#project-settings').onclick=openSettings;$('#limits-button').onclick=openSettings;
$('#spaces-button').onclick=()=>{renderSpaces();$('#spaces-dialog').showModal();};
$('#space-duration').onchange=()=>{$('#space-target-label').hidden=$('#space-duration').value!=='task';};
$('#space-form').onsubmit=async e=>{
  e.preventDefault();const button=$('#approve-space');const values=Object.fromEntries(new FormData(e.currentTarget));button.disabled=true;button.textContent='Applying between actions…';
  try{await api(`/api/projects/${activeId}/spaces`,{method:'POST',body:{root:values.root,access:values.access,duration:values.duration,taskId:values.duration==='task'?values.taskId:null,userApproved:values.approved==='on'}});e.target.reset();$('#space-target-label').hidden=false;await reload();toast('Folder approved with the selected access and duration.');}catch(error){toast(error.message);}finally{button.disabled=false;button.textContent='Approve folder';}
};
$('#spaces-list').addEventListener('click',async e=>{
  const button=e.target.closest('[data-revoke]');if(!button)return;button.disabled=true;button.textContent='Stopping and removing…';
  try{await api(`/api/projects/${activeId}/spaces/${button.dataset.revoke}`,{method:'DELETE'});await reload();toast('Access removed. Running project tasks were stopped.');}catch(error){toast(error.message);button.disabled=false;button.textContent='Remove access';}
});
$('#settings-form').onsubmit=async e=>{e.preventDefault();const p=current();try{await api(`/api/projects/${p.id}`,{method:'PATCH',body:{name:$('#setting-name').value,names:Object.fromEntries(['lead','runner','reporter'].map(role=>[role,$(`#setting-${role}-name`).value])),repository:$('#setting-repository').value,brief:$('#setting-brief').value,sourceThreadId:$('#setting-source').value.trim(),sourceMode:$('#setting-source-mode').value,limits:{tokens:Number($('#setting-tokens').value),minutes:Number($('#setting-minutes').value),delegations:Number($('#setting-delegations').value)},...(state.connection.connected?{models:Object.fromEntries(['lead','runner','reporter'].map(role=>[role,$(`#setting-${role}`).value])),efforts:Object.fromEntries(['lead','runner','reporter'].map(role=>[role,$(`#setting-${role}-effort`).value]))}:{})}});$('#settings-dialog').close();await reload();updateGit();toast('Project settings saved.');}catch(error){toast(error.message);}};
$('#check-connection').onclick=async()=>{const button=$('#check-connection');button.disabled=true;button.textContent='Checking…';try{await api('/api/connection',{method:'POST'});await reload();toast('Codex connection checked. No model task was started.');}catch(error){toast(error.message);}finally{button.disabled=false;button.textContent='Check connection';}};
$('#live-toggle').onclick=async()=>{if(state.liveEnabled){try{await api('/api/live',{method:'POST',body:{enabled:false}});await reload();toast('Live tasks paused. Running tasks were stopped.');}catch(e){toast(e.message);}}else{if(!state.connection.connected){toast('Check your Codex connection first.');return;}$('#live-dialog').showModal();}};
$('#confirm-live').onclick=async()=>{try{await api('/api/live',{method:'POST',body:{enabled:true}});$('#live-dialog').close();await reload();toast('Live tasks enabled. Your team will wait for your request.');}catch(e){toast(e.message);}};
for(const role of ['lead','reporter'])$(`#${role}-form`).onsubmit=async e=>{e.preventDefault();const input=$(`#${role}-prompt`);if(!input.value.trim())return;try{await api('/api/tasks',{method:'POST',body:{projectId:activeId,role,prompt:input.value}});input.value='';await reload();}catch(error){toast(error.message);}};
$('#stop-all').onclick=async()=>{const running=state.tasks.filter(t=>t.projectId===activeId&&t.status==='running');await Promise.all(running.map(t=>api(`/api/tasks/${t.id}/stop`,{method:'POST'})));await reload();};
$('#activity-list').addEventListener('click',async e=>{const button=e.target.closest('[data-restore]');if(!button)return;try{await api('/api/restore',{method:'POST',body:{projectId:activeId,backupId:button.dataset.restore}});await reload();toast('File checkpoint restored.');}catch(error){toast(error.message);}});
async function boot(){
  const fragment=new URLSearchParams(location.hash.slice(1));const token=fragment.get('token');
  try{
    if(token){const session=await api('/api/session',{method:'POST',body:{token}});csrf=session.csrf;sessionStorage.setItem('agent-space-csrf',csrf);history.replaceState(null,'',location.pathname);}
    if(!csrf){const session=await api('/api/session');csrf=session.csrf;sessionStorage.setItem('agent-space-csrf',csrf);}
    await reload();$('#workspace').hidden=false;updateGit();const events=new EventSource('/api/events');
    for(const name of ['event','message','project','task','usage','live'])events.addEventListener(name,scheduleReload);
    events.onerror=()=>{$('#connection-badge').textContent='Workspace reconnecting…';};
  }catch{csrf=null;sessionStorage.removeItem('agent-space-csrf');$('#auth-screen').hidden=false;}
}
boot();
