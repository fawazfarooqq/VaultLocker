import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cfg = window.VAULTLOCK_CONFIG || {};
// Live Server opens 127.0.0.1 by default, but the OAuth redirect and CORS allowlist use localhost.
// They are different origins (separate localStorage), so the session would be lost. Normalise first.
if (location.hostname === '127.0.0.1') { location.replace(location.href.replace('127.0.0.1', 'localhost')); throw new Error('Redirecting to localhost.'); }
if (!cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY || cfg.SUPABASE_PUBLISHABLE_KEY.includes('YOUR_')) {
  document.getElementById('login').classList.remove('hidden');
  document.getElementById('loginMsg').textContent = 'Add your Supabase publishable key in frontend/config.js.';
  throw new Error('VaultLock frontend configuration is incomplete.');
}
const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
const $ = (id) => document.getElementById(id);
const FOLDERS = ['General','Identity','Education','Finance','Work','Medical','Personal'];
let session = null, shownUserId = null, activeFolder = '', documents = [], profile = null, viewerTimer;
const esc = (v='') => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size = n => n < 1048576 ? `${(n/1024).toFixed(0)} KB` : `${(n/1048576).toFixed(2)} MB`;
const api = async (path, options={}) => {
  // getSession() returns a refreshed token if the cached one expired.
  const { data } = await supabase.auth.getSession(); session = data.session;
  if (!session) throw new Error('Your session has expired. Please sign in again.');
  const headers = new Headers(options.headers || {}); headers.set('Authorization', `Bearer ${session.access_token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type','application/json');
  const response = await fetch(`${cfg.API_URL}${path}`, {...options,headers});
  const result = await response.json().catch(()=>({error:'The server returned an invalid response.'}));
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
};
function showLogin() { $('app').classList.add('hidden'); $('login').classList.remove('hidden'); }
function showApp() { $('login').classList.add('hidden'); $('app').classList.remove('hidden'); }
async function ensureProfile(user) {
  const meta = user.user_metadata || {};
  const payload = {id:user.id,full_name:meta.full_name || meta.name || null,email:user.email || null,avatar_url:meta.avatar_url || meta.picture || null};
  let {data,error} = await supabase.from('profiles').select('*').eq('id',user.id).maybeSingle();
  if (error) throw error;
  if (!data) {
    const created = await supabase.from('profiles').upsert(payload,{onConflict:'id'}).select('*').single();
    data = created.data; error = created.error;
    if (error) throw error;
  }
  return data;
}
async function enter(user) {
  showApp();
  $('email').textContent = user.email || '';
  $('profileEmail').textContent = user.email || '';
  const meta = user.user_metadata || {};
  $('avatar').src = meta.avatar_url || meta.picture || '';
  try {
    profile = await ensureProfile(user); renderProfile();
    await loadDocuments();
  } catch (e) { $('docs').innerHTML = `<div class="empty">Could not open your archive.<br><br>${esc(e.message)}</div>`; }
}
// Single entry point for auth state. Both getSession() and INITIAL_SESSION resolve only after
// supabase-js has finished restoring the session (including OAuth tokens/code in the URL), so a
// null there is authoritative — except we never let a late null overwrite a session we already hold.
function applySession(event, nextSession) {
  if (nextSession) {
    session = nextSession;
    if (shownUserId !== nextSession.user.id) { shownUserId = nextSession.user.id; void enter(nextSession.user); }
  } else if (event === 'SIGNED_OUT' || !session) {
    session = null; shownUserId = null; documents = []; profile = null; showLogin();
  }
}
// Deferred with setTimeout: calling Supabase inside this callback synchronously can deadlock the auth lock.
supabase.auth.onAuthStateChange((event, s) => setTimeout(() => applySession(event, s), 0));
supabase.auth.getSession().then(({data, error}) => {
  if (error) $('loginMsg').textContent = error.message;
  applySession('INITIAL_SESSION', data?.session ?? null);
});
// Surface OAuth errors returned by Supabase/Google in the redirect URL.
const oauthError = new URLSearchParams(location.hash.slice(1)).get('error_description') || new URLSearchParams(location.search).get('error_description');
if (oauthError) $('loginMsg').textContent = oauthError;

$('google').addEventListener('click', async () => {
  $('loginMsg').textContent = 'Opening Google…';
  // Must be listed under Supabase → Authentication → URL Configuration → Redirect URLs.
  const {error} = await supabase.auth.signInWithOAuth({provider:'google',options:{redirectTo:cfg.REDIRECT_URL || window.location.href}});
  if (error) $('loginMsg').textContent = error.message;
});
$('logout').addEventListener('click', async () => {
  const {error} = await supabase.auth.signOut();
  if (error) await supabase.auth.signOut({scope:'local'}); // server revoke failed (e.g. expired); still clear this browser
  applySession('SIGNED_OUT', null);
});
$('menu').addEventListener('click', () => document.querySelector('.topbar nav').classList.toggle('open'));
$('newUpload').addEventListener('click',()=>{$('uploadDialog').showModal();$('uploadMsg').textContent='';});
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
$('editProfile').addEventListener('click',()=>{$('nameInput').value=profile?.full_name||'';$('phoneInput').value=profile?.phone||'';$('profileMsg').textContent='';$('profileDialog').showModal();});
$('profileForm').addEventListener('submit',async e=>{e.preventDefault();try{const r=await api('/api/profile',{method:'PATCH',body:JSON.stringify({full_name:$('nameInput').value,phone:$('phoneInput').value})});profile=r.profile;renderProfile();$('profileDialog').close();}catch(err){$('profileMsg').textContent=err.message;}});
function renderProfile(){ $('profileName').textContent=profile?.full_name||'Name not set'; $('profileEmail').textContent=profile?.email||session?.user.email||''; }
function renderFolders(){ $('folders').innerHTML=`<button class="folder ${activeFolder===''?'active':''}" data-folder="">All documents <span>${documents.length}</span></button>`+FOLDERS.map(f=>`<button class="folder ${activeFolder===f?'active':''}" data-folder="${esc(f)}">${esc(f)} <span>${documents.filter(d=>d.folder===f).length}</span></button>`).join('');document.querySelectorAll('[data-folder]').forEach(b=>b.addEventListener('click',()=>{activeFolder=b.dataset.folder;render();}));}
$('uploadFolder').innerHTML=FOLDERS.map(f=>`<option>${f}</option>`).join('');
async function loadDocuments(){const result=await api('/api/documents');documents=result.documents||[];render();}
function render(){
  renderFolders(); const term=$('search').value.toLowerCase(), cat=$('categoryFilter').value, type=$('typeFilter').value, sort=$('sort').value;
  const types=[...new Set(documents.map(d=>d.mime_type))]; const oldType=$('typeFilter').value;
  $('typeFilter').innerHTML='<option value="">All file types</option>'+types.map(t=>`<option value="${esc(t)}">${esc(t.split('/').pop().toUpperCase())}</option>`).join(''); $('typeFilter').value=types.includes(oldType)?oldType:'';
  const cats=[...new Set(documents.map(d=>d.category||'General'))]; const oldCat=$('categoryFilter').value;
  $('categoryFilter').innerHTML='<option value="">All categories</option>'+cats.map(c=>`<option>${esc(c)}</option>`).join(''); $('categoryFilter').value=cats.includes(oldCat)?oldCat:'';
  let list=documents.filter(d=>(!activeFolder||d.folder===activeFolder)&&(!term||d.file_name.toLowerCase().includes(term))&&(!$('categoryFilter').value||d.category===$('categoryFilter').value)&&(!$('typeFilter').value||d.mime_type===$('typeFilter').value));
  list.sort(sort==='name'?(a,b)=>a.file_name.localeCompare(b.file_name): (a,b)=>sort==='oldest'?new Date(a.created_at)-new Date(b.created_at):new Date(b.created_at)-new Date(a.created_at));
  $('folderTitle').textContent=activeFolder||'All documents'; $('total').textContent=documents.length; $('storage').textContent=size(documents.reduce((sum,d)=>sum+Number(d.file_size),0)); $('recent').textContent=documents[0]?.file_name||'—';
  $('docs').innerHTML=list.length?list.map(d=>`<article class="doc"><div class="doc-type"><span>${esc(d.folder).toUpperCase()} · ${esc(d.mime_type.split('/').pop().toUpperCase())}</span><span class="lock">${d.is_confidential?'● CONFIDENTIAL':'○ PRIVATE'}</span></div><h3>${esc(d.file_name)}</h3><div class="doc-label">${esc(d.label||d.category||'General')}</div><div class="doc-meta">${size(Number(d.file_size))} · ${new Date(d.created_at).toLocaleDateString()}<br>${esc(d.category||'General')} ${d.notes?`· ${esc(d.notes)}`:''}</div><div class="doc-actions"><button class="open" data-open="${esc(d.id)}">Open ↗</button><button data-edit="${esc(d.id)}">Edit</button><button data-delete="${esc(d.id)}">Delete</button></div></article>`).join(''):'<div class="empty">Nothing filed here yet.<br><br>Add a document to begin your private archive.</div>';
  document.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>openDocument(b.dataset.open)));document.querySelectorAll('[data-delete]').forEach(b=>b.addEventListener('click',()=>deleteDocument(b.dataset.delete)));document.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>editDocument(b.dataset.edit)));
}
['search','categoryFilter','typeFilter','sort'].forEach(id=>$(id).addEventListener(id==='search'?'input':'change',render));
$('uploadForm').addEventListener('submit',async e=>{e.preventDefault();const file=$('file').files[0];if(!file)return;if(file.size>25*1024*1024){$('uploadMsg').textContent='Maximum size is 25 MB.';return;}$('uploadMsg').textContent='Securing your document…';try{const form=new FormData();form.append('document',file);form.append('folder',$('uploadFolder').value);form.append('category',$('category').value);form.append('label',$('label').value);form.append('notes',$('notes').value);await api('/api/documents',{method:'POST',body:form});$('uploadForm').reset();$('category').value='General';$('uploadDialog').close();await loadDocuments();}catch(err){$('uploadMsg').textContent=err.message;}});
async function openDocument(id){try{const doc=documents.find(d=>d.id===id);const {downloadUrl}=await api(`/api/documents/${encodeURIComponent(id)}/download`);$('viewerName').textContent=doc.file_name;$('watermark').textContent=`VAULTLOCK · CONFIDENTIAL\n${session.user.email||''}\n${doc.file_name}`;const content=$('viewerContent');content.replaceChildren();if(doc.mime_type==='application/pdf'){const frame=document.createElement('iframe');frame.src=`${downloadUrl}#toolbar=0&navpanes=0`;frame.title='Private PDF viewer';content.append(frame);}else if(doc.mime_type.startsWith('image/')){const img=document.createElement('img');img.src=downloadUrl;img.alt=doc.file_name;img.draggable=false;content.append(img);}else{const p=document.createElement('p');p.textContent='A secure in-browser preview is not available for DOCX. Open this temporary link in a new tab to view or save the document.';const a=document.createElement('a');a.href=downloadUrl;a.target='_blank';a.rel='noopener noreferrer';a.textContent='Open temporary DOCX link ↗';content.append(p,a);}
    // Viewer controls are deterrence only; browsers cannot guarantee screenshot prevention.
    $('viewerDialog').showModal();viewerTimer=setTimeout(()=>$('viewerDialog').close(),60000);
  }catch(err){alert(err.message);}}
$('viewerDialog').addEventListener('close',()=>clearTimeout(viewerTimer));
// Deterrence only: blocks right-click and drag-out of images. It cannot stop screenshots or devtools.
['contextmenu','dragstart'].forEach(t=>$('viewerDialog').addEventListener(t,e=>e.preventDefault()));
$('viewerDialog').addEventListener('close',()=>$('viewerContent').replaceChildren());
async function deleteDocument(id){if(!confirm('Permanently delete this document?'))return;try{await api(`/api/documents/${encodeURIComponent(id)}`,{method:'DELETE'});await loadDocuments();}catch(err){alert(err.message);}}
async function editDocument(id){const doc=documents.find(d=>d.id===id);const label=prompt('Document label',doc.label||'');if(label===null)return;const category=prompt('Category',doc.category||'General');if(category===null)return;const notes=prompt('Private notes',doc.notes||'');if(notes===null)return;try{await api(`/api/documents/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({label,category,notes})});await loadDocuments();}catch(err){alert(err.message);}}
