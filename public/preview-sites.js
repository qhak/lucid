/* Preview sites are local-only simulations. They never write analytics records. */
const PREVIEW_STORAGE = 'lucid-preview-sites-v1';
const PREVIEW_FIELDS = [
  ['visitors','Unique visitors',1200,1000000000,1],
  ['visits','Total visits',1500,1000000000,1],
  ['pageviews','Total pageviews',3200,1000000000,1],
  ['revenue','Revenue (USD)',0,1000000000,.01],
  ['bounceRate','Bounce rate (%)',40,100,1],
  ['duration','Visit duration (seconds)',90,86400,1],
  ['growth','Change from previous period (%)',12,10000,.1],
];
function readPreviewSites() {
  try {
    const list = JSON.parse(localStorage.getItem(PREVIEW_STORAGE) || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter(p => p && typeof p.id === 'string' && typeof p.domain === 'string' &&
      PREVIEW_FIELDS.every(([key,,fallback,max]) => Number.isFinite(p[key]) && p[key] >= (key === 'growth' ? -100 : 0) && p[key] <= max));
  } catch { return []; }
}
function currentPreview() {
  return state.site?.startsWith('preview:') ? readPreviewSites().find(p => 'preview:' + p.id === state.site) : null;
}
function previewCards() {
  return readPreviewSites().map(p => ({domain:p.domain,previewId:p.id,visitors24h:p.visitors,delta:p.growth,spark:[]}));
}
function previewStats(p) {
  // Split the entered totals into a deterministic illustrative daily trend.
  const end = Math.min(state.range.to, Math.floor(Date.now()/1000));
  const start = state.range.from || end - 28*86400;
  const count = Math.max(1, Math.min(90, Math.ceil((end-start)/86400)));
  const weights = Array.from({length:count},(_,i)=>1+i/count*.6+(i%5)*.08);
  const sum = weights.reduce((a,b)=>a+b,0);
  const distribute = total => {
    const values = weights.map(w=>Math.floor(total*w/sum));
    const remaining = total-values.reduce((a,b)=>a+b,0);
    for(let i=0;i<remaining;i++) values[i%count]++;
    return values;
  };
  const visitors=distribute(p.visitors), visits=distribute(p.visits), pageviews=distribute(p.pageviews), revenue=distribute(Math.round(p.revenue*100));
  return {
    currency:'USD',quality:{},
    totals:{visitors:p.visitors,visits:p.visits,pageviews:p.pageviews,revenueMinor:Math.round(p.revenue*100),viewsPerVisit:p.visits ? +(p.pageviews/p.visits).toFixed(2) : 0,bounceRate:p.bounceRate,duration:p.duration},
    deltas:{visitors:p.growth,visits:p.growth,pageviews:p.growth,revenue:p.growth},
    timeseries:weights.map((_,i)=>({t:new Date((start+(end-start)*(i+.5)/count)*1000).toISOString().slice(0,10),v:visitors[i],visits:visits[i],pageviews:pageviews[i],revenue_minor:revenue[i]})),
  };
}
function previewSiteModal(id) {
  const saved = readPreviewSites().find(p => p.id === id);
  const p = saved || {domain:'my-preview.example',...Object.fromEntries(PREVIEW_FIELDS.map(([key,,value])=>[key,value]))};
  const modal = $('modal');modal.classList.add('open');
  modal.innerHTML = `<form class="modal preview-modal" id="previewform" role="dialog" aria-modal="true" aria-labelledby="previewtitle">
    <h3 id="previewtitle">${saved ? 'Edit preview site' : 'Add a preview site'}</h3>
    <p>Try a custom domain and traffic numbers. Preview data stays in this browser and does not affect tracked websites.</p>
    <label class="preview-field">Website domain<input id="previewdomain" class="domain" required maxlength="253" value="${esc(p.domain)}" placeholder="example.com"></label>
    <div class="preview-fields">${PREVIEW_FIELDS.map(([key,label,,max,step])=>`<label class="preview-field">${label}<input id="preview-${key}" type="number" min="${key==='growth' ? -100 : 0}" max="${max}" step="${step}" required value="${p[key]}"></label>`).join('')}</div>
    <div class="err" id="previewerror" role="alert" hidden></div>
    <div class="actions"><button type="button" class="btn" id="cancelpreview">Cancel</button><button class="btn primary" type="submit">${saved ? 'Save preview' : 'Create preview'}</button></div>
  </form>`;
  $('cancelpreview').addEventListener('click',closeModal);
  $('previewdomain').focus();
  $('previewform').addEventListener('submit',e=>{
    e.preventDefault();
    const error = message => { $('previewerror').hidden=false; $('previewerror').textContent=message; };
    let domain;
    try {
      const value=$('previewdomain').value.trim();
      const url=new URL(/^https?:\/\//i.test(value) ? value : 'https://'+value);
      domain=url.hostname.toLowerCase();
      if (!domain.includes('.') || !/^[a-z0-9.-]+$/.test(domain) || domain.split('.').some(part=>!part || part.length>63 || part.startsWith('-') || part.endsWith('-'))) throw Error();
    } catch { error('Enter a website domain, such as example.com.');return; }
    const next={id:saved?.id || crypto.randomUUID(),domain};
    for(const [key,,,max,step] of PREVIEW_FIELDS) {
      const value=Number($('preview-'+key).value);
      if(!Number.isFinite(value) || value<(key==='growth' ? -100 : 0) || value>max || (step===1 && !Number.isInteger(value))) {error('Enter valid numbers within the limits shown.');return;}
      next[key]=value;
    }
    if(next.visitors>next.visits || next.visits>next.pageviews) {error('Visits must be at least the number of visitors, and pageviews must be at least the number of visits.');return;}
    const sites=readPreviewSites().filter(p=>p.id!==next.id);sites.push(next);
    try { localStorage.setItem(PREVIEW_STORAGE,JSON.stringify(sites)); }
    catch {error('This browser could not save the preview. Enable site storage and try again.');return;}
    state.sitesList=state.sitesList.filter(s=>s.previewId!==next.id);
    state.sitesList.push(previewCards().find(s=>s.previewId===next.id));
    closeModal();
    if(state.site==='preview:'+next.id) {showDashboard();}
    else location.hash='/preview:'+next.id;
  });
}
function previewCardMenu(button, site) {
  const menu=document.createElement('div');menu.className='cardmenu';
  menu.innerHTML='<button data-a="open">Open preview</button><button data-a="edit">Edit numbers</button><button data-a="remove" class="danger">Remove preview</button>';
  button.closest('.sitecard').appendChild(menu);
  menu.addEventListener('click',e=>{
    e.stopPropagation();
    const action=e.target.closest('button')?.dataset.a;
    if(action==='open')location.hash='/preview:'+site.previewId;
    if(action==='edit'){closeMenus();previewSiteModal(site.previewId);}
    if(action==='remove'){
      const sites=readPreviewSites(),removed=sites.find(p=>p.id===site.previewId);
      try {localStorage.setItem(PREVIEW_STORAGE,JSON.stringify(sites.filter(p=>p.id!==site.previewId)));}
      catch {return;}
      showSites().then(()=>{
        const note=document.createElement('div');note.className='preview-banner';
        note.innerHTML='<span>Preview removed.</span><button class="btn">Undo</button>';
        $('view').prepend(note);
        note.querySelector('button').addEventListener('click',()=>{
          try {localStorage.setItem(PREVIEW_STORAGE,JSON.stringify(readPreviewSites().concat(removed)));showSites();} catch {}
        });
      });
    }
  });
}
