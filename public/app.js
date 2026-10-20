(function(){
'use strict';
var root=document.getElementById('app-root');
var me=null;            // {id, role}
var server=null;        // last data loaded/saved from the server
var state=null;         // working copy being edited
var dirty=false,saving=false,newer=null,saveErr='';
var ui={tab:'hq',rows:{},armed:null,account:false}; // tab is a section key, 'master', 'transfer', 'machines' or 'admin'; rows holds the picked row per section
var MACHINES=['EMK','EMLK','P4','L5'];
var recv=null; // set at start (needs today())
var mach={ret:null,used:'',busy:false,msg:'',err:''}; // ret is the machine being returned to the rack
var tlog={range:'today',entries:null,err:''},mlog={range:'today',machine:'all',entries:null,err:''},rlog={range:'today',entries:null,err:''};
var xfer={part:'',qty:'',picks:[],machine:null,busy:false,msg:'',err:''}; // picks holds the chosen pallets' keys, in pick order
var admin={users:[],log:[],msg:'',err:'',created:null,resetFor:null,armed:null};

/* ---------- helpers ---------- */
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function num(v){var n=Number(v);return isFinite(n)?n:0}
function fmt(n){return Math.round(n*100)/100===Math.round(n)?Math.round(n).toLocaleString():(Math.round(n*100)/100).toLocaleString()}
function when(iso){return iso?new Date(iso).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'never'}
function uid(){return 'p'+Date.now().toString(36)+Math.random().toString(36).slice(2,6)}
function clone(o){return JSON.parse(JSON.stringify(o))}
function part(k){for(var i=0;i<state.parts.length;i++)if(state.parts[i].k===k)return state.parts[i];return null}
function partName(p){return p.number||p.partId||'Unnamed part'}
// Roles: admin does everything; Supervisor sees every tab but Admin and can receive, transfer and return, but not edit the racking;
// Material Handler transfers and returns; Shipping and Receiving receives; viewer reads.
// Only admins edit the racking and Master. The server checks the same rules.
var ROLE_NAMES={viewer:'Viewer',supervisor:'Supervisor',handler:'Material Handler',shipping:'Shipping and Receiving',admin:'Admin'};
var CAN={transfer:['admin','supervisor','handler'],receive:['admin','supervisor','shipping'],return:['admin','supervisor','handler']};
function can(a){return !!me&&CAN[a].indexOf(me.role)>=0}
function canEdit(){return isAdmin()}
// Tabs each role sees, besides the racking sections.
function tabAllowed(k){
  if(!me)return false;
  var r=me.role;
  if(k==='admin')return r==='admin';
  if(k==='master')return r==='admin'||r==='viewer'||r==='supervisor';
  if(k==='transfer'||k==='machines')return r!=='shipping';
  if(k==='receive')return r!=='handler';
  return true;
}
function isAdmin(){return me&&me.role==='admin'}
function dis(){return canEdit()?'':' disabled'}
function sec(k){k=k||ui.tab;for(var i=0;i<state.sections.length;i++)if(state.sections[i].key===k)return state.sections[i];return null}
function rows(){var s=sec();return s?s.rows:[]}
function rowKey(s,r){return s.key+'|'+r.row}
function sameRow(a,b){return a!=null&&b!=null&&String(a)===String(b)}
function eachLevel(fn){state.sections.forEach(function(s){s.rows.forEach(function(r){r.racks.forEach(function(rk){rk.levels.forEach(function(lv){fn(lv,s,r)})})})})}
function store(k,v){try{if(v===undefined)localStorage.removeItem(k);else localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
function load(k){try{var v=localStorage.getItem(k);return v?JSON.parse(v):null}catch(e){return null}}
// Green outline on a confirm step while it is waiting to be confirmed.
function step(id,on){var e=document.getElementById(id);if(e)e.classList.toggle('confirm-step',on)}
function refocus(id){var e=document.getElementById(id);if(e)e.focus()}
var CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genPasskey(){var a=new Uint32Array(16),s='';crypto.getRandomValues(a);for(var i=0;i<16;i++)s+=(i&&i%4===0?'-':'')+CHARS[a[i]%CHARS.length];return s}

function api(method,url,body){
  return fetch(url,{method:method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-WMR':'1'},body:body===undefined?undefined:JSON.stringify(body)})
    .then(function(r){return r.json().catch(function(){return {}}).then(function(j){
      if(r.status===401&&url!=='/api/login'){var had=!!me;me=null;showLogin(had?'Your session ended. Please sign in again.':'');throw {silent:true}}
      if(!r.ok)throw {status:r.status,body:j,message:j.error||'Something went wrong.'};
      return j;
    })});
}

/* ---------- sign in ---------- */
function showLogin(msg){
  root.innerHTML='<div class="login-wrap"><form class="login" id="login-form" autocomplete="on">'+
    '<div class="brand"><div class="mark" aria-hidden="true"></div><h1>Americase Visual Inventory</h1></div>'+
    '<div class="field"><label for="login-id">User ID</label><input id="login-id" name="username" autocomplete="username" required autocapitalize="none" spellcheck="false"></div>'+
    '<div class="field"><label for="login-pk">Passkey</label><input id="login-pk" name="password" type="password" autocomplete="current-password" required></div>'+
    '<p class="err" id="login-err" role="alert">'+esc(msg||'')+'</p>'+
    '<button class="btn primary" type="submit" id="login-btn">Sign in</button></form></div>';
  refocus('login-id');
}
document.addEventListener('submit',function(e){
  if(e.target.id!=='login-form')return;
  e.preventDefault();
  var btn=document.getElementById('login-btn'),err=document.getElementById('login-err');
  btn.disabled=true;err.textContent='';
  api('POST','/api/login',{userId:document.getElementById('login-id').value,passkey:document.getElementById('login-pk').value})
    .then(function(j){me=j.user;return start()})
    .catch(function(x){btn.disabled=false;if(!x.silent)err.textContent=x.message;});
});

function start(){
  recv=blankRecv();
  return api('GET','/api/data').then(function(d){
    server=d;state=clone({parts:d.parts,sections:d.sections});dirty=false;newer=null;saveErr='';
    var pref=load('wmr-ui:'+me.id)||{};
    ui.tab=pref.tab||'hq';if(ui.tab==='racking')ui.tab='hq';
    if((['admin','master','transfer','machines','receive'].indexOf(ui.tab)>=0&&!tabAllowed(ui.tab))||(['admin','master','transfer','machines','receive'].indexOf(ui.tab)<0&&!sec()))ui.tab='hq';
    ui.rows=pref.rows||{};if(pref.row!=null&&ui.rows.hq==null)ui.rows.hq=pref.row;
    if(location.hash==='#master')ui.tab='master';
    var draft=load('wmr-draft:'+me.id);
    if(draft&&draft.base===server.version&&canEdit()&&draft.state&&Array.isArray(draft.state.sections)){state=draft.state;dirty=true}
    else store('wmr-draft:'+me.id);
    render();
    if(ui.tab==='admin')loadAdmin();
    loadLog();
  });
}

/* ---------- totals ---------- */
function totals(){
  var t={},loc={},byRow={},filled=0,slots=0;
  state.sections.forEach(function(s){s.rows.forEach(function(r){
    var br=byRow[rowKey(s,r)]={_filled:0,_slots:0};
    r.racks.forEach(function(rk){rk.levels.forEach(function(lv){
      var has=false;slots++;br._slots++;
      lv.items.forEach(function(it){
        if(!it.part||!part(it.part))return;has=true;
        t[it.part]=(t[it.part]||0)+num(it.qty);
        br[it.part]=(br[it.part]||0)+num(it.qty);
        loc[it.part]=(loc[it.part]||0)+1;
      });
      if(has){filled++;br._filled++}
    })});
  })});
  return {t:t,loc:loc,byRow:byRow,filled:filled,slots:slots};
}

function changed(){dirty=true;saveErr='';store('wmr-draft:'+me.id,{base:server.version,state:state});renderStatus()}
function saveUi(){store('wmr-ui:'+me.id,{tab:ui.tab,rows:ui.rows})}

/* ---------- render ---------- */
function render(){
  var T=totals();
  root.innerHTML=
    '<header class="top"><div class="brand"><div class="mark" aria-hidden="true"></div><div><h1>Americase Visual Inventory</h1></div></div>'+
    '<div class="top-right"><div class="userbar">Signed in as <b>'+esc(me.id)+'</b> <span class="role '+esc(me.role)+'">'+esc(ROLE_NAMES[me.role]||me.role)+'</span> · '+
      '<button class="linkbtn" data-act="account">Change passkey</button> · <button class="linkbtn" data-act="logout">Sign out</button></div>'+
    '<div class="savebar" id="savebar"></div></div></header>'+
    (ui.account?accountPanel():'')+
    (newer?'<div class="banner" role="status"><span><b>'+esc(newer.savedBy||'Someone')+'</b> saved a newer version at '+esc(when(newer.savedAt))+'. '+
      (dirty?'Your unsaved changes were made on the older version. Load the latest to continue; your edits will be discarded.':'')+'</span>'+
      '<button class="btn" data-act="reload">Load latest</button></div>':'')+
    '<nav class="tabs" role="tablist">'+
      state.sections.map(function(s){return tab(s.key,esc(s.name))}).join('')+['receive','Receive Material','transfer','Transfer Material','machines','Machine','master','Master','admin','Admin'].reduce(function(o,v,i,a){return i%2||!tabAllowed(v)?o:o+tab(v,a[i+1])},'')+
    '</nav>'+
    '<section id="view">'+(!tabAllowed(ui.tab)&&!sec(ui.tab)?'':ui.tab==='master'?master(T):ui.tab==='transfer'?transferView():ui.tab==='receive'?receiveView():ui.tab==='machines'?machinesView():ui.tab==='admin'?adminView():racking(T)+(isAdmin()?palletSheet():''))+'</section>';
  renderStatus();
}
function tab(v,label){return '<button class="tab" role="tab" id="tab-'+v+'" aria-selected="'+(ui.tab===v)+'" data-act="tab" data-v="'+v+'">'+label+'</button>'}

function renderStatus(){
  var el=document.getElementById('savebar');if(!el)return;
  var cls='',txt;
  if(!canEdit()){cls='off';txt='View only'}
  else if(saving)txt='Saving…';
  else if(saveErr){cls='dirty';txt=saveErr}
  else if(dirty){cls='dirty';txt='Unsaved changes'}
  else txt=server.savedAt?'Saved '+when(server.savedAt)+(server.savedBy?' by '+server.savedBy:''):'Loaded from HQ_Metal_Racking.xlsx';
  el.innerHTML='<span class="status '+cls+'" role="status">'+esc(txt)+'</span>'+
    (canEdit()&&dirty?'<button class="btn ghost" data-act="revert">Undo all</button>':'')+
    (canEdit()?'<button class="btn primary" data-act="save" '+(!dirty||saving||newer?'disabled':'')+'>Save changes</button>':'');
}

function accountPanel(){
  return '<form class="account" id="account-form"><div class="panel-h"><h3>Change your passkey</h3><button class="btn ghost sm" type="button" data-act="account">Close</button></div>'+
    '<div class="formrow"><div class="field"><label for="acc-cur">Current passkey</label><input id="acc-cur" type="password" autocomplete="current-password" required></div>'+
    '<div class="field"><label for="acc-new">New passkey</label><input id="acc-new" type="password" autocomplete="new-password" minlength="8" required></div>'+
    '<div class="field"><label for="acc-new2">Confirm new passkey</label><input id="acc-new2" type="password" autocomplete="new-password" minlength="8" required></div>'+
    '<button class="btn primary" type="submit">Update passkey</button></div><p class="err" id="acc-msg" role="alert" style="padding:0 14px 12px"></p></form>';
}

function racking(T){
  var S=sec(),R=S.rows,r=null,ri=-1;
  R.forEach(function(x,i){if(sameRow(x.row,ui.rows[S.key])){r=x;ri=i}});
  if(!r&&R.length){r=R[0];ri=0;ui.rows[S.key]=r.row}
  var h='<div class="rowpick"><div class="label">Select row</div><div class="chips">';
  R.forEach(function(x,i){
    var b=T.byRow[rowKey(S,x)];var pct=b._slots?Math.round(b._filled/b._slots*100):0;
    h+='<button class="chip" data-act="row" data-v="'+i+'" aria-pressed="'+(i===ri)+'"><b>Row '+esc(x.row)+'</b>'+
      '<span class="meter"><i style="width:'+pct+'%"></i></span><small class="num">'+b._filled+' / '+b._slots+' filled</small></button>';
  });
  if(canEdit())h+='<button class="chip add" data-act="addrow">+ Add row</button>';
  h+='</div></div>';
  if(!r)return h+'<p class="empty-note">No rows in '+esc(S.name)+' yet.'+(canEdit()?' Add a row to start assigning parts.':'')+'</p>';
  var b=T.byRow[rowKey(S,r)];
  h+='<div class="rowhead"><h2>Row '+esc(r.row)+'</h2><div class="pills">';
  var any=false;
  state.parts.forEach(function(p){if(b[p.k]!=null){any=true;h+='<span class="pill"><b class="num">'+fmt(b[p.k])+'</b> × '+esc(partName(p))+'</span>'}});
  if(!any)h+='<span class="pill muted">No parts assigned in this row</span>';
  h+='<span class="pill muted num">'+b._filled+' of '+b._slots+' locations filled</span>';
  if(canEdit())h+='<button class="btn danger ghost'+(ui.armed==='row'?' armed':'')+'" data-act="delrow">'+(ui.armed==='row'?'Confirm remove Row '+esc(r.row):'Remove row')+'</button>';
  h+='</div></div><div class="racks">';
  // Every level number used in this row, top first, so a rack missing a level shows a gap there.
  var all={};r.racks.forEach(function(rk){rk.levels.forEach(function(lv){all[lv.level]=1})});
  var levelNums=Object.keys(all).map(Number).sort(function(x,y){return y-x});
  r.racks.forEach(function(rk,ki){
    h+='<div class="rack"><div class="rack-h"><b>Rack '+esc(rk.rack)+'</b><span>'+esc(rk.label)+'</span></div><div class="frame">';
    levelNums.forEach(function(n){
      var li=-1;rk.levels.forEach(function(x,i){if(x.level===n&&li<0)li=i});
      if(li<0){h+='<div class="level gap"><div class="addr"><span class="tagl">'+esc(r.row+'-'+rk.rack+'-'+n)+'</span></div><div class="lines"><span class="gapnote">No slot</span></div></div>';return}
      var lv=rk.levels[li];
      var addr=r.row+'-'+rk.rack+'-'+lv.level;
      var lines=lv.items.length?lv.items:[null];
      var filled=lv.items.some(function(it){return it.part});
      h+='<div class="level'+(filled?'':' empty')+'"><div class="addr"><span class="tagl">'+esc(addr)+'</span>'+(lv.height!==''&&lv.height!=null?'<span class="ht">'+esc(lv.height)+' in</span>':'')+'</div><div class="lines">';
      lines.forEach(function(it,i){
        var id=addr+'-'+(it?i:'new');
        var d='data-r="'+ri+'" data-k="'+ki+'" data-l="'+li+'" data-i="'+(it?i:'new')+'"';
        h+='<div class="line"><select id="sel-'+id+'" data-act="part" '+d+' aria-label="Part number at '+addr+'"'+dis()+'><option value="">Select part number</option>';
        state.parts.forEach(function(p){h+='<option value="'+esc(p.k)+'"'+(it&&it.part===p.k?' selected':'')+'>'+esc(partName(p))+'</option>'});
        // Supervisors see what is on each pallet but not its quantity.
        h+='</select>'+(me.role==='supervisor'?'<span></span>':'<input id="qty-'+id+'" class="num" type="number" inputmode="numeric" min="0" step="1" data-act="qty" '+d+' aria-label="Quantity at '+addr+'" value="'+(it&&it.qty!==''&&it.qty!=null?esc(it.qty):'')+'"'+(it&&it.part&&canEdit()?'':' disabled placeholder="Qty"')+'>');
        h+=it&&canEdit()?'<button class="x" data-act="rmline" '+d+' aria-label="Clear '+addr+'" title="Clear">×</button>':'<span></span>';
        h+='</div>';
      });
      h+='</div></div>';
    });
    h+='</div><div class="floor" aria-hidden="true"></div></div>';
  });
  return h+'</div>';
}

function master(T){
  var grand=0;state.parts.forEach(function(p){grand+=T.t[p.k]||0});
  var ids={};state.parts.forEach(function(p){var n=(p.number||'').trim().toLowerCase();if(n)ids[n]=(ids[n]||0)+1});
  var h='<div class="stack">';
  h+='<div class="kpis"><div class="kpi"><span class="label">Parts on master</span><b class="num">'+state.parts.length+'</b></div>'+
     '<div class="kpi"><span class="label">Total quantity racked</span><b class="num">'+fmt(grand)+'</b></div>'+
     '<div class="kpi"><span class="label">Locations filled</span><b class="num">'+T.filled+' / '+T.slots+'</b></div></div>';
  h+='<div class="panel"><div class="panel-h"><h3>Metal Master</h3></div><div class="scroll"><table><thead><tr>'+
     '<th style="min-width:190px">Part Number</th><th style="min-width:380px">Part Description</th>'+
     '<th class="r" style="min-width:90px">Qty / Pallet</th><th style="min-width:110px">Dedicated Case</th><th class="r" style="min-width:90px">Qty / Case</th>'+
     '<th class="r">Total Qty</th><th class="r">Locations</th><th class="r">Pallets</th>'+(canEdit()?'<th></th>':'')+'</tr></thead><tbody>';
  if(!state.parts.length)h+='<tr><td colspan="9" class="empty-note">No parts yet.</td></tr>';
  state.parts.forEach(function(p){
    var tot=T.t[p.k]||0,loc=T.loc[p.k]||0,dup=(p.number||'').trim()&&ids[p.number.trim().toLowerCase()]>1;
    function cell(f,cls,type,extra){return '<td'+(cls?' class="'+cls+'"':'')+'><input id="'+f+'-'+p.k+'" data-act="pf" data-p="'+p.k+'" data-f="'+f+'"'+(type?' type="number" min="0" inputmode="decimal" class="num"':'')+(extra||'')+dis()+' value="'+esc(p[f])+'" aria-label="'+f+'"></td>'}
    h+='<tr>'+cell('number','',false,dup?' class="bad" title="Another part already uses this Part Number"':'')+cell('description')+
      cell('qtyPerPallet','r',true)+cell('dedicatedCase')+cell('qtyPerCase','r',true)+
      '<td class="r total num'+(tot?'':' zero')+'">'+fmt(tot)+'</td><td class="r num'+(loc?'':' zero')+'">'+loc+'</td>'+
      '<td class="r num'+(tot?'':' zero')+'">'+(num(p.qtyPerPallet)>0?fmt(tot/num(p.qtyPerPallet)):'–')+'</td>'+
      (canEdit()?'<td><button class="btn danger ghost'+(ui.armed===p.k?' armed':'')+'" data-act="delpart" data-p="'+p.k+'" style="white-space:nowrap">'+(ui.armed===p.k?(loc?'Remove + clear '+loc+' loc.':'Confirm'):'Remove')+'</button></td>':'')+'</tr>';
  });
  h+='</tbody><tfoot><tr><td colspan="5">All parts</td><td class="r total num">'+fmt(grand)+'</td><td class="r num">'+T.filled+'</td><td colspan="'+(canEdit()?2:1)+'"></td></tr></tfoot></table></div>'+
     (canEdit()?'<div class="tablefoot"><button class="btn" data-act="addpart">+ Add part</button></div>':'')+'</div>';
  var secs=state.sections.filter(function(s){return s.rows.length});
  var grp=secs.length>1; // section headings only when more than one section is switched on
  h+='<div class="panel"><div class="panel-h"><h3>Quantity by row</h3></div><div class="scroll"><table class="matrix"><thead><tr><th'+(grp?' rowspan="2"':'')+'>Part Number</th>';
  if(grp){secs.forEach(function(s){h+='<th class="sec" colspan="'+s.rows.length+'">'+esc(s.name)+'</th>'});
  h+='<th class="r" rowspan="2">Total</th></tr><tr>';}
  secs.forEach(function(s){s.rows.forEach(function(r){h+='<th class="r">Row '+esc(r.row)+'</th>'})});
  h+=(grp?'':'<th class="r">Total</th>')+'</tr></thead><tbody>';
  state.parts.forEach(function(p){
    h+='<tr><td>'+esc(partName(p))+'</td>';
    secs.forEach(function(s){s.rows.forEach(function(r){var v=T.byRow[rowKey(s,r)][p.k];h+='<td class="r num'+(v?'':' zero')+'">'+(v?fmt(v):'–')+'</td>'})});
    h+='<td class="r num"><b>'+fmt(T.t[p.k]||0)+'</b></td></tr>';
  });
  h+='</tbody></table></div></div>'+(isAdmin()?logPanel('mlog'):'')+'</div>';
  return h;
}

/* ---------- material transfer ---------- */
// Every pallet on the racking holding the chosen material, in racking order. Transfers always move whole pallets.
function pallets(k){
  var out=[],multi=state.sections.length>1;
  state.sections.forEach(function(s){s.rows.forEach(function(r){r.racks.forEach(function(rk){rk.levels.forEach(function(lv){
    lv.items.forEach(function(it,i){
      if(it.part!==k||!(num(it.qty)>0))return;
      var loc=r.row+'-'+rk.rack+'-'+lv.level;
      out.push({key:s.key+'|'+loc+'|'+i,section:s.key,row:r.row,rack:rk.rack,level:lv.level,item:i,qty:num(it.qty),addr:loc,loc:(multi?s.name+' ':'')+loc,routing:it.routing||'',received:it.received||''});
    });
  })})})});
  // Oldest received first; pallets without a date go last.
  return out.map(function(x,i){x.n=i;return x}).sort(function(a,b){return (a.received||'9999')<(b.received||'9999')?-1:(a.received||'9999')>(b.received||'9999')?1:a.n-b.n});
}
var MAX_PALLETS=2;
function day(d){if(!d)return '–';var p=d.split('-');return new Date(+p[0],+p[1]-1,+p[2]).toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'})}
function today(){var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function xferQty(){var n=Number(xfer.qty);return xfer.qty!==''&&isFinite(n)&&n>0?n:0}
// The picked pallets that still exist, in the order they were picked, and their total.
function picked(list){
  var by={};list.forEach(function(x){by[x.key]=x});
  var out=xfer.picks.map(function(k){return by[k]}).filter(Boolean);
  xfer.picks=out.map(function(x){return x.key});
  return {list:out,total:out.reduce(function(t,x){return t+x.qty},0)};
}
function transferView(){
  var h='<div class="stack"><div class="panel"><div class="panel-h"><h3>Transfer material</h3><p>Pick the material and quantity, then choose one green pallet or two pallets that add up to it. Oldest received is listed first. Whole pallets are moved.</p></div>';
  h+='<div class="formrow"><div class="field grow"><label for="xf-part">Material type</label><select id="xf-part" data-act="xpart"><option value="">Select part number</option>';
  state.parts.forEach(function(p){h+='<option value="'+esc(p.k)+'"'+(xfer.part===p.k?' selected':'')+'>'+esc(partName(p))+'</option>'});
  h+='</select></div><div class="field"><label for="xf-qty">Quantity requested</label><input id="xf-qty" class="num" type="number" inputmode="numeric" min="1" step="1" data-act="xqty" value="'+esc(xfer.qty)+'"></div></div>';
  h+='</div><div id="xf-results" class="stack">'+transferResults()+'</div></div>';
  return h;
}
function transferResults(){
  var h=xfer.msg?'<p class="ok-msg" role="status">'+esc(xfer.msg)+'</p>':'';
  if(!xfer.part||!part(xfer.part))return h+'<p class="empty-note">Select a material type to see where it is racked.</p>';
  var q=xferQty(),p=part(xfer.part),list=pallets(xfer.part);
  if(!q)xfer.picks=[];
  var P=picked(list),enough=q&&P.total>=q;
  if(!enough)xfer.machine=null;
  if(q){
    var pct=Math.min(100,Math.round(P.total/q*100));
    h+='<div class="tally'+(enough?' ok':'')+'"><span class="label">Selected / requested</span><b class="num">'+fmt(P.total)+' / '+fmt(q)+'</b>'+
      '<span class="meter"><i style="width:'+pct+'%"></i></span><span class="dim">'+(enough?'Enough selected.':fmt(q-P.total)+' more needed.')+'</span>'+
      (P.list.length===1&&!enough&&!list.some(function(x){return x.key!==P.list[0].key&&P.total+x.qty>=q})?'<span class="err">No other pallet makes up the rest. Remove '+esc(P.list[0].loc)+' and pick another.</span>':'')+'</div>';
  }
  h+='<div class="panel"><div class="panel-h"><h3>'+esc(partName(p))+' on the racking</h3><p>'+(q?'Green pallets cover '+fmt(q)+' on their own. Yellow pallets have less; pick a second pallet to make up the rest. Red pallets can\'t make up the rest. Up to '+MAX_PALLETS+' pallets.':'Enter the quantity requested to choose pallets.')+'</p></div><div class="scroll"><table class="xfer"><thead><tr><th style="width:44px"></th><th>Date received</th><th>Part Number</th><th>Location</th><th class="r">Quantity</th></tr></thead><tbody>';
  if(!list.length)h+='<tr><td colspan="5" class="empty-note">No pallets of this material are on the racking.</td></tr>';
  list.forEach(function(x,i){
    // Unpicked pallets can be added while fewer than MAX_PALLETS are picked, the request isn't met yet, and this pallet would meet it as the last pick.
    var sel=xfer.picks.indexOf(x.key)>=0,n=P.list.length,cls='',can=false;
    if(q){
      if(sel){cls=x.qty>=q?'go':'part';can=true}
      else if(enough||n>=MAX_PALLETS)cls='off';
      else if(n===MAX_PALLETS-1&&P.total+x.qty<q)cls='no';
      else{cls=x.qty>=q?'go':'part';can=true}
    }
    h+='<tr class="'+cls+(sel?' picked':'')+'"'+(can?' data-act="xpick" data-v="'+esc(x.key)+'"':'')+'><td>'+
      (can?'<button class="pick" aria-pressed="'+sel+'" aria-label="'+(sel?'Remove ':'Add ')+esc(x.loc)+'"></button>':'')+'</td>'+
      '<td class="num">'+esc(day(x.received))+(i<2?' <span class="rec">Recommended</span>':'')+'</td><td>'+esc(partName(p))+'</td><td><span class="tagl inline">'+esc(x.loc)+'</span></td><td class="r num"><b>'+fmt(x.qty)+'</b></td></tr>';
  });
  h+='</tbody></table></div></div>';
  if(xfer.err)h+='<p class="err" role="alert">'+esc(xfer.err)+'</p>';
  if(!q)return h;
  h+='<div class="panel"><div class="panel-h"><h3>Selected pallets</h3></div><div class="scroll"><table><thead><tr><th>#</th><th>Location</th><th>Part Number</th><th>Routing #</th><th>Date received</th><th class="r">Quantity</th><th></th></tr></thead><tbody>';
  if(!P.list.length)h+='<tr><td colspan="7" class="empty-note">No pallets selected yet. Pick pallets from the table above.</td></tr>';
  P.list.forEach(function(x,i){h+='<tr><td class="num">'+(i+1)+'</td><td><span class="tagl inline">'+esc(x.loc)+'</span></td><td>'+esc(partName(p))+'</td><td class="num">'+esc(x.routing)+'</td><td class="num">'+esc(day(x.received))+'</td><td class="r num">'+fmt(x.qty)+'</td><td class="r"><button class="btn ghost sm" data-act="xpick" data-v="'+esc(x.key)+'">Remove</button></td></tr>'});
  h+='</tbody>'+(P.list.length?'<tfoot><tr><td colspan="5">Total of '+P.list.length+' pallet'+(P.list.length>1?'s':'')+'</td><td class="r num">'+fmt(P.total)+' / '+fmt(q)+'</td><td></td></tr></tfoot>':'')+'</table></div></div>';
  if(!enough)return h;
  h+='<div class="panel"><div class="panel-h"><h3>Send to machine</h3><p>'+P.list.length+' pallet'+(P.list.length>1?'s':'')+' · '+fmt(P.total)+' × '+esc(partName(p))+'</p></div><div class="machines">';
  MACHINES.forEach(function(m){h+='<button class="machine" data-act="xmachine" data-v="'+m+'" aria-pressed="'+(xfer.machine===m)+'">'+m+'</button>'});
  h+='</div><div class="tablefoot'+(xfer.machine&&can('transfer')&&!dirty?' confirm-step':'')+'">';
  if(!can('transfer'))h+='<p class="dim">Your account can view but not transfer material.</p>';
  else if(dirty)h+='<p class="err">Save or undo your racking changes before transferring.</p>';
  else h+='<button class="btn primary" data-act="xgo"'+(!xfer.machine||xfer.busy?' disabled':'')+'>'+(xfer.busy?'Transferring…':xfer.machine?'Transfer '+P.list.length+' pallet'+(P.list.length>1?'s':'')+' to '+xfer.machine:'Choose a machine')+'</button>';
  h+='</div></div>';
  if(xfer.machine)h+='<div class="panel"><div class="panel-h"><h3>Ready for print</h3><p>Pick sheet for this transfer. It fits on one 8.5 × 11 in page.</p><button class="btn" data-act="xprint">Print</button></div><div class="sheet-wrap">'+pickSheet(p,q,P)+'</div></div>';
  return h;
}
// A one-page printable sheet: each rack row holding a listed pallet drawn as a grid (racks across, levels top to bottom), then the list.
// o: {title, dir ('To'|'From'), machine, sub (html), items [{section,row,addr,loc,pn,qty,routing,received}], foot, footQty}
function sheet(o){
  var num_={};o.items.forEach(function(x,i){num_[x.section+'|'+x.addr]=i+1});
  var h='<div class="sheet"><div class="sheet-h"><div><b>'+esc(o.title)+'</b><span>'+esc(when(new Date().toISOString()))+' · '+esc(me.id)+'</span></div><div class="to">'+o.dir+' <b>'+esc(o.machine)+'</b></div></div>';
  h+='<p class="sheet-part">'+o.sub+'</p><div class="sheet-racks">';
  state.sections.forEach(function(s){s.rows.forEach(function(r){
    if(!o.items.some(function(x){return x.section===s.key&&String(x.row)===String(r.row)}))return;
    var all={};r.racks.forEach(function(rk){rk.levels.forEach(function(lv){all[lv.level]=1})});
    var lvls=Object.keys(all).map(Number).sort(function(a,b){return b-a});
    h+='<div class="sheet-row"><div class="sheet-row-h">'+(state.sections.length>1?esc(s.name)+' · ':'')+'Row '+esc(r.row)+'</div><table class="rackmap"><thead><tr><th></th>';
    r.racks.forEach(function(rk){h+='<th>Rack '+esc(rk.rack)+'</th>'});
    h+='</tr></thead><tbody>';
    lvls.forEach(function(n){
      h+='<tr><th>L'+n+'</th>';
      r.racks.forEach(function(rk){
        var lv=rk.levels.filter(function(x){return x.level===n})[0],addr=r.row+'-'+rk.rack+'-'+n,k=num_[s.key+'|'+addr];
        if(!lv)h+='<td class="none"></td>';
        else if(k)h+='<td class="hit"><b>'+k+'</b> '+esc(addr)+'</td>';
        else h+='<td class="'+(lv.items.length?'full':'')+'">'+esc(addr)+'</td>';
      });
      h+='</tr>';
    });
    h+='</tbody></table></div>';
  })});
  h+='</div><table class="sheet-list"><thead><tr><th>#</th><th>Location</th><th>Part Number</th><th>Routing #</th><th>Received</th><th class="r">Quantity</th>'+(o.noMachine?'':'<th>Machine</th>')+'<th>Done</th></tr></thead><tbody>';
  if(!o.items.length)h+='<tr><td colspan="8">Nothing goes back to the racking.</td></tr>';
  o.items.forEach(function(x,i){h+='<tr><td>'+(i+1)+'</td><td><b>'+esc(x.loc)+'</b></td><td>'+esc(x.pn)+'</td><td>'+esc(x.routing)+'</td><td>'+esc(day(x.received))+'</td><td class="r">'+fmt(x.qty)+'</td>'+(o.noMachine?'':'<td>'+esc(o.machine)+'</td>')+'<td><span class="box"></span></td></tr>'});
  h+='</tbody><tfoot><tr><td colspan="5">'+esc(o.foot)+'</td><td class="r">'+fmt(o.footQty)+'</td>'+(o.noMachine?'':'<td>'+esc(o.machine)+'</td>')+'<td></td></tr></tfoot></table></div>';
  return h;
}
function pickSheet(p,q,P){
  return sheet({title:'Material transfer',dir:'To',machine:xfer.machine,sub:'<b>'+esc(partName(p))+'</b>'+(p.description?' · '+esc(p.description):''),
    items:P.list.map(function(x){return {section:x.section,row:x.row,addr:x.addr,loc:x.loc,pn:partName(p),qty:x.qty,routing:x.routing,received:x.received}}),
    foot:P.list.length+' pallet'+(P.list.length>1?'s':'')+' · requested '+fmt(q),footQty:P.total});
}
function printSheet(){
  var src=document.querySelector('#view .sheet');if(!src)return;
  var pr=document.getElementById('print-root');
  if(!pr){pr=document.createElement('div');pr.id='print-root';document.body.appendChild(pr)}
  pr.innerHTML=src.outerHTML;
  window.print();
}
function refreshTransfer(){var el=document.getElementById('xf-results');if(el)el.innerHTML=transferResults()}
function doTransfer(){
  var q=xferQty(),P=picked(pallets(xfer.part));
  if(!q||P.total<q||!xfer.machine||xfer.busy||dirty||!can('transfer'))return;
  xfer.busy=true;xfer.err='';xfer.msg='';refreshTransfer();
  var m=xfer.machine,name=partName(part(xfer.part)||{});
  api('POST','/api/transfer',{part:xfer.part,requested:q,machine:m,pallets:P.list.map(function(x){return {section:x.section,row:x.row,rack:x.rack,level:x.level,item:x.item,qty:x.qty}})})
    .then(function(d){
      server=d;state=clone({parts:d.parts,sections:d.sections});newer=null;
      xfer={part:'',qty:'',picks:[],machine:null,busy:false,err:'',msg:'Moved '+P.list.length+' pallet'+(P.list.length>1?'s':'')+' ('+fmt(P.total)+' × '+name+') from '+P.list.map(function(x){return x.loc}).join(', ')+' to '+m+'.'};
      render();loadLog();
    })
    .catch(function(x){xfer.busy=false;if(x.silent)return;xfer.err=x.message;reloadLatest()});
}
/* ---------- receive material ---------- */
// New pallets coming in: pick the material, how many pallets and what is on each, then an open spot on the racking for each one.
function blankRecv(){return {part:'',count:'',qtys:[],routings:[],date:today(),spots:[],confirmed:false,busy:false,msg:'',err:''}}
// Every pallet needs a quantity and a routing number before spots are offered.
function recvReady(){var n=recvCount();if(!n)return false;for(var i=0;i<n;i++)if(!recvQty(i)||!String(recv.routings[i]||'').trim())return false;return true}
function recvCount(){var n=Number(recv.count);return recv.count!==''&&Number.isInteger(n)&&n>0&&n<=50?n:0}
function spotKey(s,r,rk,lv){return s.key+'|'+r.row+'|'+rk.rack+'|'+lv.level}
// Spots chosen that are still open, in the order they were chosen.
function recvSpots(){
  var open={};
  state.sections.forEach(function(s){s.rows.forEach(function(r){r.racks.forEach(function(rk){rk.levels.forEach(function(lv){
    if(!lv.items.length)open[spotKey(s,r,rk,lv)]={section:s.key,row:r.row,rack:rk.rack,level:lv.level,addr:r.row+'-'+rk.rack+'-'+lv.level,loc:(state.sections.length>1?s.name+' ':'')+r.row+'-'+rk.rack+'-'+lv.level};
  })})})});
  recv.spots=recv.spots.filter(function(k){return open[k]}).slice(0,recvCount());
  return recv.spots.map(function(k){return open[k]});
}
function recvQty(i){var v=recv.qtys[i];var n=Number(v);return v!==''&&v!=null&&isFinite(n)&&n>0?n:0}
function receiveView(){
  var h='<div class="stack"><div class="panel"><div class="panel-h"><h3>Receive Material</h3><p>Pick the material, how many pallets came in and the quantity on each, then an open spot on the racking for each pallet.</p></div>';
  h+='<div class="formrow"><div class="field grow"><label for="rv-part">Material type</label><select id="rv-part" data-act="rpart"><option value="">Select part number</option>';
  state.parts.forEach(function(p){h+='<option value="'+esc(p.k)+'"'+(recv.part===p.k?' selected':'')+'>'+esc(partName(p))+'</option>'});
  h+='</select></div><div class="field"><label for="rv-count">Pallets received</label><input id="rv-count" class="num" type="number" inputmode="numeric" min="1" max="50" step="1" data-act="rcount" value="'+esc(recv.count)+'"></div>'+
    '<div class="field"><label for="rv-date">Date received</label><input id="rv-date" type="date" data-act="rdate" value="'+esc(recv.date)+'"></div></div>';
  if(recv.msg)h+='<p class="ok-msg" role="status" style="padding:0 14px 12px">'+esc(recv.msg)+'</p>';
  h+='<div id="rv-qtys">'+recvQtys()+'</div></div><div id="rv-body" class="stack">'+recvBody()+'</div>'+logPanel('rlog')+'</div>';
  return h;
}
function recvQtys(){
  var n=recvCount(),p=part(recv.part);
  if(!p||!n)return '';
  var h='<div id="rv-step" class="'+(recv.confirmed?'':'confirm-step')+'"><div class="scroll"><table class="rvq"><thead><tr><th>Pallet</th><th class="r" style="width:140px">Quantity on pallet</th><th style="width:200px">Routing #</th></tr></thead><tbody>';
  for(var i=0;i<n;i++){
    if(recv.qtys[i]==null)recv.qtys[i]=p.qtyPerPallet!==''&&p.qtyPerPallet!=null?String(p.qtyPerPallet):'';
    h+='<tr><td>Pallet '+(i+1)+'</td><td><input id="rv-q-'+i+'" class="num" type="number" inputmode="numeric" min="1" step="1" data-act="rqty" data-i="'+i+'" value="'+esc(recv.qtys[i])+'" aria-label="Quantity on pallet '+(i+1)+'"></td>'+
      '<td><input id="rv-rt-'+i+'" data-act="rrt" data-i="'+i+'" value="'+esc(recv.routings[i]||'')+'" aria-label="Routing number for pallet '+(i+1)+'" required></td></tr>';
  }
  return h+'</tbody></table></div><div class="confirmrow"><p class="err" id="rv-cerr" role="alert"></p><button class="btn primary" data-act="rconfirm">Confirm</button></div></div>';
}
function recvBody(){
  var n=recvCount(),p=part(recv.part);
  if(!p)return '<p class="empty-note">Select a material type to start.</p>';
  if(!n)return '<p class="empty-note">Enter how many pallets were received (up to 50).</p>';
  if(!recv.confirmed)return '<p class="empty-note">Enter the quantity and routing # for each pallet, then press Confirm to see open spots on the racking.</p>';
  if(!recvReady())return '<p class="err">Every pallet needs a quantity and a routing #. Fill them in to see open spots.</p>';
  var S=recvSpots(),idx={};S.forEach(function(x,i){idx[x.section+'|'+x.row+'|'+x.rack+'|'+x.level]=i+1});
  var h='<div class="tally'+(S.length===n?' ok':'')+'"><span class="label">Open spots chosen</span><b class="num">'+S.length+' / '+n+'</b><span class="dim">'+(S.length===n?'Every pallet has a spot.':'Click an open spot for pallet '+(S.length+1)+'.')+'</span></div>';
  h+='<div class="panel"><div class="panel-h"><h3>Open spots on the racking</h3><p>Open spots are white. Click one for each pallet, in order; click it again to clear it.</p></div><div class="spotmaps">';
  var anyOpen=false;
  state.sections.forEach(function(s){s.rows.forEach(function(r){
    var all={};r.racks.forEach(function(rk){rk.levels.forEach(function(lv){all[lv.level]=1})});
    var lvls=Object.keys(all).map(Number).sort(function(a,b){return b-a});
    h+='<div class="spotmap"><div class="sheet-row-h">'+(state.sections.length>1?esc(s.name)+' · ':'')+'Row '+esc(r.row)+'</div><table><thead><tr><th></th>'+r.racks.map(function(rk){return '<th>Rack '+esc(rk.rack)+'</th>'}).join('')+'</tr></thead><tbody>';
    lvls.forEach(function(L){
      h+='<tr><th>L'+L+'</th>';
      r.racks.forEach(function(rk){
        var lv=rk.levels.filter(function(x){return x.level===L})[0];
        if(!lv){h+='<td class="none"></td>';return}
        var addr=r.row+'-'+rk.rack+'-'+L,k=spotKey(s,r,rk,lv),i=idx[s.key+'|'+r.row+'|'+rk.rack+'|'+L];
        if(lv.items.length){var q=part(lv.items[0].part);h+='<td class="full" title="'+esc(q?partName(q):'')+'">'+esc(addr)+'</td>';return}
        anyOpen=true;
        var can=i||S.length<n;
        h+='<td class="open'+(i?' hit':'')+'"><button data-act="rspot" data-v="'+esc(k)+'"'+(can?'':' disabled')+' aria-pressed="'+!!i+'">'+(i?'<b>'+i+'</b> ':'')+esc(addr)+'</button></td>';
      });
      h+='</tr>';
    });
    h+='</tbody></table></div>';
  })});
  h+='</div>'+(anyOpen?'':'<p class="empty-note">There are no open spots on the racking.</p>')+'</div>';
  if(recv.err)h+='<p class="err" role="alert">'+esc(recv.err)+'</p>';
  if(S.length<n)return h;
  var total=0,items=S.map(function(x,i){total+=recvQty(i);return {section:x.section,row:x.row,addr:x.addr,loc:x.loc,pn:partName(p),qty:recvQty(i),routing:recv.routings[i]||'',received:recv.date}});
  h+='<div class="panel"><div class="panel-h"><h3>Put away</h3><p>'+n+' pallet'+(n>1?'s':'')+' · '+fmt(total)+' × '+esc(partName(p))+'</p></div><div class="tablefoot'+(can('receive')&&!dirty?' confirm-step':'')+'">';
  if(!can('receive'))h+='<p class="dim">Your account can view but not receive material.</p>';
  else if(dirty)h+='<p class="err">Save or undo your racking changes before receiving material.</p>';
  else h+='<button class="btn primary" data-act="rgo"'+(recv.busy?' disabled':'')+'>'+(recv.busy?'Receiving…':'Receive '+n+' pallet'+(n>1?'s':'')+' onto the racking')+'</button>';
  h+='</div></div>';
  h+='<div class="panel"><div class="panel-h"><h3>Ready for print</h3><p>Put-away sheet: take each pallet to the spot marked. It fits on one 8.5 × 11 in page.</p><button class="btn" data-act="xprint">Print</button></div><div class="sheet-wrap">'+
    sheet({title:'Receive material',dir:'To',machine:'Racking',noMachine:true,sub:'<b>'+esc(partName(p))+'</b>'+(p.description?' · '+esc(p.description):'')+' · received '+esc(day(recv.date)),items:items,foot:n+' pallet'+(n>1?'s':'')+' received',footQty:total})+'</div></div>';
  return h;
}
function refreshRecv(qtys){if(qtys){var q=document.getElementById('rv-qtys');if(q)q.innerHTML=recvQtys()}var el=document.getElementById('rv-body');if(el)el.innerHTML=recvBody()}
function doReceive(){
  var n=recvCount(),S=recvSpots();
  if(!n||!recv.confirmed||!recvReady()||S.length<n||recv.busy||dirty||!can('receive'))return;
  recv.busy=true;recv.err='';refreshRecv();
  var name=partName(part(recv.part)||{});
  api('POST','/api/receive',{part:recv.part,received:recv.date,pallets:S.map(function(x,i){return {section:x.section,row:x.row,rack:x.rack,level:x.level,qty:recvQty(i),routing:recv.routings[i]||''}})})
    .then(function(d){
      server=d;state=clone({parts:d.parts,sections:d.sections});newer=null;
      recv=blankRecv();recv.msg='Received '+n+' pallet'+(n>1?'s':'')+' of '+name+' into '+S.map(function(x){return x.loc}).join(', ')+'.';
      render();loadLog();
    })
    .catch(function(x){recv.busy=false;if(x.silent)return;recv.err=x.message;reloadLatest()});
}

/* ---------- machines ---------- */
function atMachine(m){return ((server.machines||{})[m])||[]}
function secName(k){var s=sec(k);return s?s.name:k}
function fromLoc(x){var f=x.from||{};return {section:f.section||'hq',row:f.row,addr:f.row+'-'+f.rack+'-'+f.level,loc:(state.sections.length>1?secName(f.section||'hq')+' ':'')+(x.loc||f.row+'-'+f.rack+'-'+f.level)}}
// Same steps as the server: the quantity used comes off the oldest-received pallets first; the rest of each pallet goes back to its spot.
function returnPlan(list,used){
  var total=list.reduce(function(t,x){return t+num(x.qty)},0);
  if(!isFinite(used)||used<0||used>total)return null;
  var left=used;
  return list.map(function(p,n){return {p:p,n:n}}).sort(function(a,b){return String(a.p.received||'9999').localeCompare(String(b.p.received||'9999'))||a.n-b.n})
    .map(function(o){var u=Math.min(left,num(o.p.qty));left-=u;return {p:o.p,used:u,back:num(o.p.qty)-u}});
}
// Default quantity used: what was requested for each transfer still at the machine, capped at what is there.
function requestedAt(m){
  var seen={},req=0,total=0;
  atMachine(m).forEach(function(x){total+=num(x.qty);if(x.batch&&!seen[x.batch]){seen[x.batch]=1;req+=num(x.requested)}});
  return Math.min(req,total);
}
function machinesView(){
  var h='<div class="stack"><div class="mcards">';
  MACHINES.forEach(function(m){
    var list=atMachine(m),tot=list.reduce(function(t,x){return t+num(x.qty)},0);
    h+='<div class="mcard'+(mach.ret===m?' on':'')+'"><div class="mcard-h"><h3>'+m+'</h3>'+
      (list.length&&can('return')?'<button class="btn'+(mach.ret===m?' primary':'')+'" data-act="mret" data-v="'+m+'">'+(mach.ret===m?'Close return':'Return to Rack')+'</button>':'')+
      '</div><div class="mpals">';
    if(!list.length)h+='<p class="dim">No material at this machine.</p>';
    list.forEach(function(x){var p=part(x.part),f=fromLoc(x);
      // The stack of sheets is drawn in proportion to a full pallet (Qty / Pallet), so a part-used pallet looks lower.
      var full=p&&num(p.qtyPerPallet)>0?num(p.qtyPerPallet):num(x.qty),ht=Math.round(6+54*Math.min(1,full?num(x.qty)/full:1));
      h+='<div class="mpal" title="Pallet from '+esc(f.loc)+'"><div class="info"><b class="pn">'+esc(p?partName(p):'Removed part')+'</b><span class="tagl inline">'+esc(f.loc)+'</span>'+
        '<span class="q num">'+fmt(num(x.qty))+' <small>/ '+(x.requested?fmt(num(x.requested)):'–')+'</small></span><small class="lbl">pallet qty / requested</small></div>'+
        '<div class="stackwrap" aria-hidden="true"><div class="load" style="height:'+ht+'px"></div></div><div class="deck" aria-hidden="true"><i></i><i></i><i></i></div></div>'});
    h+='</div></div>';
  });
  h+='</div>';
  if(mach.msg)h+='<p class="ok-msg" role="status">'+esc(mach.msg)+'</p>';
  if(mach.ret&&atMachine(mach.ret).length)h+='<div id="mr-results" class="stack">'+returnPanel()+'</div>';
  // totals by part
  var any=false,tot={},grand=0;MACHINES.forEach(function(m){tot[m]=0});
  var rowsH='';
  state.parts.forEach(function(p){
    var v={},row=0;MACHINES.forEach(function(m){v[m]=atMachine(m).reduce(function(t,x){return t+(x.part===p.k?num(x.qty):0)},0);row+=v[m];tot[m]+=v[m]});
    if(!row)return;any=true;grand+=row;
    rowsH+='<tr><td>'+esc(partName(p))+'</td>'+MACHINES.map(function(m){return '<td class="r num'+(v[m]?'':' zero')+'">'+(v[m]?fmt(v[m]):'–')+'</td>'}).join('')+'<td class="r num"><b>'+fmt(row)+'</b></td></tr>';
  });
  h+='<div class="panel"><div class="panel-h"><h3>Material at Machine</h3></div><div class="scroll"><table class="matrix"><thead><tr><th>Part Number</th>'+MACHINES.map(function(m){return '<th class="r">'+m+'</th>'}).join('')+'<th class="r">Total</th></tr></thead><tbody>'+
    (any?rowsH:'<tr><td colspan="'+(MACHINES.length+2)+'" class="empty-note">No material is at a machine.</td></tr>')+'</tbody>'+
    (any?'<tfoot><tr><td>All material</td>'+MACHINES.map(function(m){return '<td class="r num">'+fmt(tot[m])+'</td>'}).join('')+'<td class="r num">'+fmt(grand)+'</td></tr></tfoot>':'')+'</table></div></div>';
  h+=logPanel('tlog');
  return h+'</div>';
}
function returnPanel(){
  var m=mach.ret,list=atMachine(m),total=list.reduce(function(t,x){return t+num(x.qty)},0);
  var h='<div class="panel"><div class="panel-h"><h3>Return to rack · '+m+'</h3><p>Enter how much was used at '+m+'. That comes off the oldest pallets first, and what is left on each pallet goes back to the spot it came from.</p></div>';
  h+='<div id="mr-step" class="formrow'+(mach.confirmed?'':' confirm-step')+'"><div class="field"><label for="mr-used">Quantity used</label><input id="mr-used" class="num" type="number" inputmode="numeric" min="0" max="'+total+'" step="1" data-act="mused" value="'+esc(mach.used)+'"></div><p class="dim" style="margin:0 0 10px">'+fmt(total)+' sheets at '+m+'</p>'+
    '<button class="btn primary" data-act="mconfirm">Confirm</button></div><p class="err" id="mr-cerr" role="alert" style="padding:0 14px 12px"></p></div>';
  return h+'<div id="mr-body" class="stack">'+returnBody()+'</div>';
}
// The plan, the confirm button and the print sheet: redrawn as the quantity used is typed.
function returnBody(){
  var m=mach.ret,list=atMachine(m),total=list.reduce(function(t,x){return t+num(x.qty)},0);
  var used=mach.used===''?NaN:Number(mach.used),plan=returnPlan(list,used);
  // Nothing moves until the quantity consumed is confirmed; editing it asks for Confirm again.
  if(!mach.confirmed||!plan)return '<p class="empty-note">Enter the quantity used at '+esc(m)+' and press Confirm.</p>';
  var h='<div class="panel"><div class="panel-h"><h3>Back to Racking</h3></div><div class="scroll"><table><thead><tr><th>Pallet from</th><th>Part Number</th><th>Routing #</th><th class="r">At machine</th><th class="r">Used</th><th class="r">Quantity to Return</th></tr></thead><tbody>';
  var back=0,trash=plan.filter(function(x){return !x.back}).length;
  plan.forEach(function(x){var p=part(x.p.part),f=fromLoc(x.p);back+=x.back;
    h+='<tr><td><span class="tagl inline">'+esc(f.loc)+'</span></td><td>'+esc(p?partName(p):'Removed part')+'</td><td class="num">'+esc(x.p.routing)+'</td><td class="r num">'+fmt(num(x.p.qty))+'</td><td class="r num">'+fmt(x.used)+'</td><td class="r num"><b>'+(x.back?fmt(x.back):'<span class="trash">Used</span>')+'</b></td></tr>'});
  h+='</tbody><tfoot><tr><td colspan="3">Total</td><td class="r num">'+fmt(total)+'</td><td class="r num">'+fmt(used)+'</td><td class="r num">'+fmt(back)+'</td></tr></tfoot></table></div>';
  if(mach.err)h+='<p class="err" role="alert" style="padding:10px 14px 0">'+esc(mach.err)+'</p>';
  h+='<div class="tablefoot'+(can('return')&&!dirty?' confirm-step':'')+'">';
  if(dirty)h+='<p class="err">Save or undo your racking changes before returning material.</p>';
  else h+='<button class="btn primary" data-act="mgo"'+(mach.busy?' disabled':'')+'>'+(mach.busy?'Working…':back?'Return to rack'+(trash?' and move '+trash+' pallet'+(trash>1?'s':'')+' to Used':''):'Move '+(trash>1?trash+' pallets':'pallet')+' to Used')+'</button> <button class="btn ghost" data-act="mret" data-v="'+m+'">Cancel</button>';
  h+='</div></div>';
  var items=plan.filter(function(x){return x.back}).map(function(x){var p=part(x.p.part),f=fromLoc(x.p);return {section:f.section,row:f.row,addr:f.addr,loc:f.loc,pn:p?partName(p):'',qty:x.back,routing:x.p.routing,received:x.p.received}});
  h+='<div class="panel"><div class="panel-h"><h3>Ready for print</h3><p>Return sheet: put each pallet back in the spot marked. It fits on one 8.5 × 11 in page.</p><button class="btn" data-act="xprint">Print</button></div><div class="sheet-wrap">'+
    sheet({title:back?'Return to rack':'Pallets used',dir:'From',machine:m,sub:'Used at '+esc(m)+': <b>'+fmt(used)+'</b> of '+fmt(total)+' sheets. '+(back?'Return each pallet below to the spot it came from.':'')+(trash?' <b>'+trash+' used-up pallet'+(trash>1?'s':'')+' go'+(trash>1?'':'es')+' to Used.</b>':''),items:items,foot:items.length+' pallet'+(items.length===1?'':'s')+' back to the racking',footQty:back})+'</div></div>';
  return h;
}
function refreshReturn(){var el=document.getElementById('mr-body');if(el)el.innerHTML=returnBody()}
function doReturn(){
  var m=mach.ret,list=atMachine(m),used=Number(mach.used),plan=returnPlan(list,used);
  if(!m||!plan||!mach.confirmed||mach.busy||dirty||!can('return')||mach.used==='')return;
  mach.busy=true;mach.err='';refreshReturn();
  api('POST','/api/return',{machine:m,used:used,ids:list.map(function(x){return x.id})})
    .then(function(d){
      server=d;state=clone({parts:d.parts,sections:d.sections});newer=null;
      var back=plan.filter(function(x){return x.back});
      var tr=plan.length-back.length;
      mach={ret:null,used:'',busy:false,err:'',msg:m+': '+(back.length?'returned '+back.map(function(x){return fmt(x.back)+' to '+fromLoc(x.p).loc}).join(', '):'nothing returned to the racking')+(tr?'; '+tr+' used-up pallet'+(tr>1?'s':'')+' moved to Used':'')+'. '+fmt(used)+' used.'};
      render();loadLog();
    })
    .catch(function(x){mach.busy=false;if(x.silent)return;mach.err=x.message;reloadLatest()});
}
var RANGES=[['today','Today'],['week','Last week'],['month','Last month'],['year','Last year',1],['all','All time',1]];
// Three logs read the same list: Machine Transfer Log (Machine tab), Receiving Log (Receive Material tab),
// and the admins' Transfer Log on Master, which holds both and filters by machine or receiving.
var LOGS={tlog:{title:'Machine Transfer Log',st:tlog,only:'machine'},rlog:{title:'Receiving Log',st:rlog,only:'receive'},mlog:{title:'Transfer Log',st:mlog,menus:true}};
function loadLog(id){
  if(!id){if(ui.tab==='machines')loadLog('tlog');if(ui.tab==='receive')loadLog('rlog');if(ui.tab==='master'&&isAdmin())loadLog('mlog');return}
  var st=LOGS[id].st,since=new Date();since.setHours(0,0,0,0);
  var redraw=function(){var el=document.getElementById(id);if(el)el.outerHTML=logPanel(id)};
  return api('GET','/api/transfers?range='+st.range+'&since='+since.getTime()).then(function(j){st.entries=j.entries;st.err='';redraw()})
    .catch(function(x){if(!x.silent){st.err=x.message;redraw()}});
}
function logFilters(id){
  var L=LOGS[id],st=L.st,ranges=RANGES.filter(function(r){return !r[2]||isAdmin()});
  if(!L.menus)return '<div class="chips">'+ranges.map(function(r){return '<button class="chip sm" data-act="lrange" data-log="'+id+'" data-v="'+r[0]+'" aria-pressed="'+(st.range===r[0])+'">'+r[1]+'</button>'}).join('')+'</div>';
  return '<div class="menus"><label class="field"><span>Date</span><select data-act="lrangesel" data-log="'+id+'">'+ranges.map(function(r){return '<option value="'+r[0]+'"'+(st.range===r[0]?' selected':'')+'>'+r[1]+'</option>'}).join('')+'</select></label>'+
    '<label class="field"><span>Machine / receiving</span><select data-act="lmachsel" data-log="'+id+'">'+[['all','All'],['receive','Receiving']].concat(MACHINES.map(function(m){return [m,m]})).map(function(o){return '<option value="'+o[0]+'"'+(st.machine===o[0]?' selected':'')+'>'+o[1]+'</option>'}).join('')+'</select></label>'+
    '<button class="btn sm" data-act="lreset" data-log="'+id+'">Reset to default</button></div>';
}
function logPanel(id){
  var L=LOGS[id],st=L.st;
  var h='<div class="panel" id="'+id+'"><div class="panel-h"><h3>'+L.title+'</h3>'+logFilters(id)+'</div><div class="scroll"><table class="log"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Part Number</th><th class="r">Qty</th><th>From</th><th>To</th></tr></thead><tbody>';
  var list=(st.entries||[]).filter(function(e){
    var rcv=e.kind==='receive';
    if(L.only==='machine')return !rcv&&!!e.machine;
    if(L.only==='receive')return rcv;
    return st.machine==='all'||(st.machine==='receive'?rcv:!rcv&&e.machine===st.machine);
  });
  if(st.err)h+='<tr><td colspan="7" class="err">'+esc(st.err)+'</td></tr>';
  else if(!st.entries)h+='<tr><td colspan="7" class="empty-note">Loading…</td></tr>';
  else if(!list.length)h+='<tr><td colspan="7" class="empty-note">Nothing in this period.</td></tr>';
  list.forEach(function(e){
    var pals=Array.isArray(e.pallets)?e.pallets:[],from,to,pns={};
    if(e.kind==='receive'){
      pns[e.partNumber||e.part]=1;
      from='<b>Receiving</b>';to=esc(pals.map(function(x){return x.loc+' ('+fmt(x.qty)+')'}).join(', '));
    }else{
      var ret=e.kind==='return';
      if(ret)pals.forEach(function(x){pns[x.partNumber||x.part]=1});else pns[e.partNumber||e.part]=1;
      var tr=ret?pals.filter(function(x){return !x.qty}).length:0;
      var rack=esc(pals.filter(function(x){return !ret||x.qty}).map(function(x){return x.loc+(ret?' ('+fmt(x.qty)+')':'')}).concat(tr?['Used ('+tr+' pallet'+(tr>1?'s':'')+')']:[]).join(', ')),m='<b>'+esc(e.machine)+'</b>';
      from=ret?m:rack;to=ret?rack:m;
    }
    h+='<tr><td class="dim">'+esc(when(e.at))+'</td><td>'+esc(e.by)+'</td><td>'+(e.kind==='receive'?'Receive':'Transfer')+'</td><td>'+esc(Object.keys(pns).join(', '))+'</td><td class="r num">'+fmt(e.qty)+'</td>'+
      '<td class="detail">'+from+'</td><td class="detail">'+to+'</td></tr>';
  });
  return h+'</tbody></table></div></div>';
}

// Admins only: every pallet on the racking with its routing number and date received, plus a form to add a pallet.
function palletSheet(){
  var multi=state.sections.length>1,n=0,spots='';
  var h='<div class="panel"><div class="panel-h"><h3>Pallet tracking</h3></div><div class="scroll"><table class="tracking"><thead><tr>'+
    '<th>Location</th><th style="min-width:190px">Part Number</th><th class="r">Qty</th><th style="min-width:130px">Routing #</th><th style="min-width:150px">Date received</th><th></th></tr></thead><tbody>';
  state.sections.forEach(function(s){s.rows.forEach(function(r,ri){r.racks.forEach(function(rk,ki){rk.levels.forEach(function(lv,li){
    var loc=r.row+'-'+rk.rack+'-'+lv.level,lab=(multi?s.name+' ':'')+loc,d0='data-s="'+esc(s.key)+'" data-r="'+ri+'" data-k="'+ki+'" data-l="'+li+'"';
    spots+='<option value="'+esc(s.key+'|'+ri+'|'+ki+'|'+li)+'">'+esc(lab)+(lv.items.length?' (has a pallet)':'')+'</option>';
    lv.items.forEach(function(it,ii){
      var p=part(it.part);if(!p)return;n++;
      var d=d0+' data-i="'+ii+'"';
      h+='<tr><td><span class="tagl inline">'+esc(lab)+'</span></td><td>'+esc(partName(p))+'</td><td class="r num">'+fmt(num(it.qty))+'</td>'+
        '<td><input data-act="pt" data-f="routing" '+d+' value="'+esc(it.routing)+'" aria-label="Routing number at '+esc(loc)+'"></td>'+
        '<td><input type="date" data-act="pt" data-f="received" '+d+' value="'+esc(it.received)+'" aria-label="Date received at '+esc(loc)+'"></td>'+
        '<td><button class="x" data-act="ptdel" '+d+' aria-label="Remove pallet at '+esc(loc)+'" title="Remove pallet">×</button></td></tr>';
    });
  })})})});
  if(!n)h+='<tr><td colspan="6" class="empty-note">No pallets on the racking.</td></tr>';
  h+='</tbody></table></div><div class="formrow addpal"><div class="field"><label for="ap-loc">Location</label><select id="ap-loc"><option value="">Select location</option>'+spots+'</select></div>'+
    '<div class="field grow"><label for="ap-part">Part Number</label><select id="ap-part"><option value="">Select part number</option>'+state.parts.map(function(p){return '<option value="'+esc(p.k)+'">'+esc(partName(p))+'</option>'}).join('')+'</select></div>'+
    '<div class="field"><label for="ap-qty">Qty</label><input id="ap-qty" class="num" type="number" min="1" step="1" inputmode="numeric" placeholder="Qty / pallet"></div>'+
    '<div class="field"><label for="ap-rt">Routing #</label><input id="ap-rt" autocomplete="off"></div>'+
    '<div class="field"><label for="ap-date">Date received</label><input id="ap-date" type="date" value="'+today()+'"></div>'+
    '<button class="btn primary" data-act="addpallet">Add pallet</button></div><p class="err" id="ap-err" role="alert" style="padding:0 14px 12px"></p></div>';
  return h;
}

/* ---------- admin ---------- */
function loadAdmin(){
  return Promise.all([api('GET','/api/admin/users'),api('GET','/api/admin/audit')]).then(function(r){
    admin.users=r[0].users;admin.log=r[1].entries;if(ui.tab==='admin')render();
  }).catch(function(x){if(!x.silent){admin.err=x.message;render()}});
}
var ACTIONS={'login':'Signed in','login-failed':'Failed sign-in','save':'Saved racking','create-user':'Added user','update-user':'Changed user','delete-user':'Deleted user','change-passkey':'Changed own passkey','transfer':'Transferred material','return':'Returned to rack','undo-transfers':'Undid all transfers'};
function adminView(){
  var h='<div class="stack">';
  h+='<form class="panel" id="add-user-form"><div class="panel-h"><h3>Add user</h3></div>'+
    '<div class="formrow"><div class="field"><label for="nu-id">User ID</label><input id="nu-id" autocomplete="off" autocapitalize="none" spellcheck="false" required pattern="[A-Za-z0-9._\\-]{2,40}" title="2–40 letters, numbers, dots, dashes or underscores"></div>'+
    '<div class="field"><label for="nu-role">Role</label><select id="nu-role">'+['handler','shipping','supervisor','viewer','admin'].map(function(r){return '<option value="'+r+'">'+ROLE_NAMES[r]+'</option>'}).join('')+'</select></div>'+
    '<div class="field grow"><label for="nu-pk">Passkey</label><div class="pkrow"><input id="nu-pk" autocomplete="new-password" minlength="8" required spellcheck="false"><button class="btn" type="button" data-act="genpk" data-for="nu-pk">Generate</button></div></div>'+
    '<button class="btn primary" type="submit">Add user</button></div>'+
    (admin.created?'<div class="notice" role="status"><span>Give <b>'+esc(admin.created.id)+'</b> this passkey. The app keeps only a scrambled copy, so it cannot be shown again.</span><code>'+esc(admin.created.pk)+'</code><button class="btn sm" type="button" data-act="copy" data-v="'+esc(admin.created.pk)+'">Copy</button><button class="btn ghost sm" type="button" data-act="dismiss">Done</button></div>':'')+
    (admin.err?'<p class="err" role="alert" style="padding:0 14px 12px">'+esc(admin.err)+'</p>':'')+
    (admin.msg?'<p class="ok-msg" role="status" style="padding:0 14px 12px">'+esc(admin.msg)+'</p>':'')+
    '</form>';
  h+='<div class="panel"><div class="panel-h"><h3>Users</h3></div><div class="scroll"><table><thead><tr><th>User ID</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Added</th><th class="r">Actions</th></tr></thead><tbody>';
  admin.users.forEach(function(u){
    var self=u.id===me.id,key=encodeURIComponent(u.id);
    h+='<tr><td><b>'+esc(u.id)+'</b>'+(self?' <span class="dim">(you)</span>':'')+'</td>'+
      '<td><select data-act="setrole" data-u="'+esc(u.id)+'" aria-label="Role for '+esc(u.id)+'">'+['viewer','handler','shipping','supervisor','admin'].map(function(r){return '<option value="'+r+'"'+(u.role===r?' selected':'')+'>'+ROLE_NAMES[r]+'</option>'}).join('')+'</select></td>'+
      '<td><span class="statuspill '+(u.active?'on':'off')+'">'+(u.active?'Active':'Disabled')+'</span></td>'+
      '<td class="dim">'+esc(when(u.lastLogin))+'</td><td class="dim">'+esc(when(u.createdAt))+(u.createdBy?' by '+esc(u.createdBy):'')+'</td><td>';
    if(admin.resetFor===u.id){
      h+='<div class="inline-reset"><input id="rp-'+key+'" aria-label="New passkey for '+esc(u.id)+'" minlength="8" spellcheck="false" autocomplete="new-password">'+
        '<button class="btn sm" data-act="genpk" data-for="rp-'+key+'">Generate</button><button class="btn primary sm" data-act="savereset" data-u="'+esc(u.id)+'">Set passkey</button><button class="btn ghost sm" data-act="cancelreset">Cancel</button></div>';
    }else{
      h+='<div class="actions"><button class="btn sm" data-act="reset" data-u="'+esc(u.id)+'">Reset passkey</button>'+
        (self?'':'<button class="btn sm" data-act="toggle" data-u="'+esc(u.id)+'">'+(u.active?'Disable':'Enable')+'</button>'+
        '<button class="btn danger sm'+(admin.armed===u.id?' armed':'')+'" data-act="deluser" data-u="'+esc(u.id)+'">'+(admin.armed===u.id?'Confirm delete':'Delete')+'</button>')+'</div>';
    }
    h+='</td></tr>';
  });
  h+='</tbody></table></div></div>';
  h+='<div class="panel"><div class="panel-h"><h3>Activity</h3><button class="btn ghost sm" data-act="refreshlog">Refresh</button></div><div class="scroll"><table class="log"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody>';
  if(!admin.log.length)h+='<tr><td colspan="4" class="empty-note">No activity yet.</td></tr>';
  admin.log.filter(function(e){return e.action!=='transfer'&&e.action!=='return'}).slice(0,100).forEach(function(e){
    h+='<tr><td class="dim">'+esc(when(e.at))+'</td><td>'+esc(e.user)+'</td><td>'+esc(ACTIONS[e.action]||e.action)+'</td><td class="detail dim">'+esc(e.detail)+'</td></tr>';
  });
  h+='</tbody></table></div></div></div>';
  return h;
}
function adminDo(p,okMsg){
  admin.err='';admin.msg='';
  return p.then(function(){admin.msg=okMsg||'';admin.armed=null;admin.resetFor=null;return loadAdmin()})
    .catch(function(x){if(!x.silent){admin.err=x.message;render()}});
}

/* ---------- saving ---------- */
function save(){
  if(!dirty||saving||!canEdit())return;
  saving=true;saveErr='';renderStatus();
  api('PUT','/api/data',{baseVersion:server.version,parts:state.parts,sections:state.sections})
    .then(function(j){
      saving=false;dirty=false;
      server={version:j.version,savedAt:j.savedAt,savedBy:j.savedBy,parts:clone(state.parts),sections:clone(state.sections)};
      store('wmr-draft:'+me.id);renderStatus();
    })
    .catch(function(x){
      saving=false;if(x.silent)return;
      if(x.status===409){newer=x.body;render();return}
      saveErr=x.message||'Save failed. Try again.';renderStatus();
    });
}
function reloadLatest(){
  api('GET','/api/data').then(function(d){
    server=d;state=clone({parts:d.parts,sections:d.sections});dirty=false;newer=null;saveErr='';store('wmr-draft:'+me.id);render();
  }).catch(function(){});
}
setInterval(function(){
  if(!me||saving||document.hidden)return;
  api('GET','/api/version').then(function(v){
    if(v.version===server.version)return;
    if(!dirty&&!isTyping()){reloadLatest();return}
    if(!newer||newer.version!==v.version){newer=v;render()}
  }).catch(function(){});
},20000);
function isTyping(){var a=document.activeElement;return a&&(a.tagName==='INPUT'||a.tagName==='SELECT')}
window.addEventListener('beforeunload',function(e){if(dirty&&!saving){e.preventDefault();e.returnValue=''}});

/* ---------- events ---------- */
function lvOf(t){return rows()[+t.dataset.r].racks[+t.dataset.k].levels[+t.dataset.l]}

root.addEventListener('click',function(e){
  var t=e.target.closest('[data-act]');if(!t||!me)return;var a=t.dataset.act;
  if(t.tagName==='SELECT'||t.tagName==='INPUT')return;
  if(a!=='delrow'&&a!=='delpart'&&ui.armed){ui.armed=null;if(a!=='tab'&&a!=='row')render()}
  if(a!=='deluser'&&admin.armed){admin.armed=null}
  if(a==='tab'){ui.tab=t.dataset.v;ui.armed=null;saveUi();render();refocus('tab-'+ui.tab);if(ui.tab==='admin')loadAdmin();loadLog()}
  else if(a==='row'){var rw=rows()[+t.dataset.v];if(rw)ui.rows[ui.tab]=rw.row;saveUi();render()}
  else if(a==='logout'){api('POST','/api/logout',{}).finally(function(){me=null;showLogin('')})}
  else if(a==='account'){ui.account=!ui.account;render();if(ui.account)refocus('acc-cur')}
  else if(a==='reload')reloadLatest();
  else if(a==='save')save();
  else if(a==='revert'){state=clone({parts:server.parts,sections:server.sections});dirty=false;saveErr='';store('wmr-draft:'+me.id);render()}
  else if(!canEdit()&&['addrow','delrow','rmline','addpart','delpart'].indexOf(a)>=0)return;
  else if(a==='addrow'){
    var R=rows(),last=R[R.length-1],n;
    if(last&&typeof last.row==='string'&&/^[A-Z]$/.test(last.row))n=last.row==='Z'?'AA':String.fromCharCode(last.row.charCodeAt(0)+1); // lettered rows continue A, B, C…
    else n=R.reduce(function(m,r){return Math.max(m,num(r.row))},0)+1;
    var racks=last?last.racks.map(function(rk){return {rack:rk.rack,label:rk.label,levels:rk.levels.map(function(lv){return {level:lv.level,height:lv.height,items:[]}})}})
      :[1,2].map(function(k){return {rack:k,label:'12 ft',levels:[9,8,7,6,5,4,3,2,1].map(function(l){return {level:l,height:17,items:[]}})}});
    R.push({row:n,racks:racks});ui.rows[ui.tab]=n;saveUi();changed();render();
  }
  else if(a==='delrow'){
    if(ui.armed!=='row'){ui.armed='row';render();return}
    var S=sec();S.rows=S.rows.filter(function(r){return !sameRow(r.row,ui.rows[S.key])});ui.armed=null;ui.rows[S.key]=S.rows.length?S.rows[0].row:null;saveUi();changed();render();
  }
  else if(a==='rmline'){lvOf(t).items.splice(+t.dataset.i,1);changed();render()}
  else if(a==='addpart'){var p={k:uid(),number:'',description:'',partId:'',qtyPerPallet:'',dedicatedCase:'',qtyPerCase:''};state.parts.push(p);changed();render();refocus('number-'+p.k)}
  else if(a==='delpart'){
    var k=t.dataset.p;if(ui.armed!==k){ui.armed=k;render();return}
    state.parts=state.parts.filter(function(p){return p.k!==k});
    eachLevel(function(lv){lv.items=lv.items.filter(function(it){return it.part!==k})});
    ui.armed=null;changed();render();
  }
  /* admin actions */
  else if(a==='genpk'){var f=document.getElementById(t.dataset.for);if(f){f.value=genPasskey();f.focus()}}
  else if(a==='copy'){var v=t.dataset.v;(navigator.clipboard?navigator.clipboard.writeText(v):Promise.reject()).then(function(){t.textContent='Copied'},function(){t.textContent='Select and copy'})}
  else if(a==='dismiss'){admin.created=null;render()}
  else if(a==='reset'){admin.resetFor=t.dataset.u;admin.err='';admin.msg='';render();refocus('rp-'+encodeURIComponent(t.dataset.u))}
  else if(a==='cancelreset'){admin.resetFor=null;render()}
  else if(a==='savereset'){
    var u=t.dataset.u,inp=document.getElementById('rp-'+encodeURIComponent(u)),pk=inp?inp.value:'';
    adminDo(api('PATCH','/api/admin/users/'+encodeURIComponent(u),{passkey:pk}).then(function(){admin.created={id:u,pk:pk}}),'Passkey reset for '+u+'. Their other sessions were signed out.');
  }
  else if(a==='toggle'){
    var usr=admin.users.filter(function(x){return x.id===t.dataset.u})[0];if(!usr)return;
    adminDo(api('PATCH','/api/admin/users/'+encodeURIComponent(usr.id),{active:!usr.active}),usr.id+(usr.active?' disabled.':' enabled.'));
  }
  else if(a==='deluser'){
    if(admin.armed!==t.dataset.u){admin.armed=t.dataset.u;render();return}
    adminDo(api('DELETE','/api/admin/users/'+encodeURIComponent(t.dataset.u)),t.dataset.u+' deleted.');
  }
  else if(a==='refreshlog')loadAdmin();
  /* transfer actions */
  else if(a==='xpick'){var pi=xfer.picks.indexOf(t.dataset.v);if(pi>=0)xfer.picks.splice(pi,1);else if(xfer.picks.length<MAX_PALLETS)xfer.picks.push(t.dataset.v);xfer.err='';xfer.msg='';refreshTransfer()}
  else if(a==='xprint')printSheet();
  else if(a==='xmachine'){xfer.machine=t.dataset.v;refreshTransfer()}
  else if(a==='xgo')doTransfer();
  else if(a==='mret'){if(mach.ret===t.dataset.v)mach.ret=null;else{mach.ret=t.dataset.v;mach.used=String(requestedAt(mach.ret))}mach.confirmed=false;mach.err='';mach.msg='';render()}
  else if(a==='mgo')doReturn();
  else if(a==='mconfirm'){
    var tot=atMachine(mach.ret).reduce(function(t2,x){return t2+num(x.qty)},0),uv=Number(mach.used),ce2=document.getElementById('mr-cerr');
    if(mach.used===''||!isFinite(uv)||uv<0||uv>tot){mach.confirmed=false;if(ce2)ce2.textContent='Enter a quantity used from 0 to '+fmt(tot)+'.';refreshReturn();return}
    if(ce2)ce2.textContent='';mach.confirmed=true;step('mr-step',false);refreshReturn();
  }
  else if(a==='rspot'){var si=recv.spots.indexOf(t.dataset.v);if(si>=0)recv.spots.splice(si,1);else if(recv.spots.length<recvCount())recv.spots.push(t.dataset.v);recv.err='';recv.msg='';refreshRecv()}
  else if(a==='rgo')doReceive();
  else if(a==='lrange'){var lst=LOGS[t.dataset.log].st;lst.range=t.dataset.v;lst.entries=null;var el=document.getElementById(t.dataset.log);if(el)el.outerHTML=logPanel(t.dataset.log);loadLog(t.dataset.log)}
  else if(a==='lreset'){var rs=LOGS[t.dataset.log].st;rs.range='today';rs.machine='all';rs.entries=null;var el2=document.getElementById(t.dataset.log);if(el2)el2.outerHTML=logPanel(t.dataset.log);loadLog(t.dataset.log)}
  else if(a==='rconfirm'){
    var bad=[];for(var ci=0;ci<recvCount();ci++)if(!recvQty(ci)||!String(recv.routings[ci]||'').trim())bad.push(ci+1);
    var ce=document.getElementById('rv-cerr');
    if(bad.length){recv.confirmed=false;if(ce)ce.textContent='Enter the quantity and routing # for pallet'+(bad.length>1?'s ':' ')+bad.join(', ')+'.';refreshRecv();return}
    if(ce)ce.textContent='';recv.confirmed=true;step('rv-step',false);refreshRecv();
  }
  else if(a==='ptdel'&&isAdmin()){var S2=sec(t.dataset.s);S2.rows[+t.dataset.r].racks[+t.dataset.k].levels[+t.dataset.l].items.splice(+t.dataset.i,1);changed();render()}
  else if(a==='addpallet'&&isAdmin()){
    var ge=function(id){return document.getElementById(id)},er=ge('ap-err'),lp=ge('ap-loc').value.split('|'),pk=ge('ap-part').value,pp=part(pk),aq=ge('ap-qty').value;
    if(lp.length<4){er.textContent='Choose a location.';return}
    if(!pp){er.textContent='Choose a part number.';return}
    var qn=aq===''?num(pp.qtyPerPallet):Number(aq);
    if(!(qn>0)){er.textContent='Enter the quantity on the pallet.';return}
    sec(lp[0]).rows[+lp[1]].racks[+lp[2]].levels[+lp[3]].items.push({part:pk,qty:qn,routing:ge('ap-rt').value.trim(),received:ge('ap-date').value||today()});
    changed();render();
  }
});

root.addEventListener('change',function(e){
  var t=e.target;
  if(t.dataset.act==='lrangesel'||t.dataset.act==='lmachsel'){var ls=LOGS[t.dataset.log].st;if(t.dataset.act==='lmachsel'){ls.machine=t.value;var e3=document.getElementById(t.dataset.log);if(e3)e3.outerHTML=logPanel(t.dataset.log);return}ls.range=t.value;ls.entries=null;loadLog(t.dataset.log);return}
  if(t.dataset.act==='rpart'){recv.part=t.value;recv.qtys=[];recv.confirmed=false;recv.err='';recv.msg='';refreshRecv(true);return}
  if(t.dataset.act==='xpart'){xfer.part=t.value;xfer.picks=[];xfer.machine=null;xfer.err='';xfer.msg='';refreshTransfer();return}
  if(t.dataset.act==='setrole'){adminDo(api('PATCH','/api/admin/users/'+encodeURIComponent(t.dataset.u),{role:t.value}),t.dataset.u+' is now '+(ROLE_NAMES[t.value]||t.value)+'.');return}
  if(t.dataset.act!=='part'||!canEdit())return;
  var lv=lvOf(t),v=t.value,p=part(v);
  if(t.dataset.i==='new'){if(!v)return;lv.items.push({part:v,qty:p&&p.qtyPerPallet!==''?num(p.qtyPerPallet):'',routing:'',received:today()})}
  else{var it=lv.items[+t.dataset.i];it.part=v;if(v&&(it.qty===''||it.qty==null)&&p&&p.qtyPerPallet!=='')it.qty=num(p.qtyPerPallet)}
  changed();render();
  var r=rows()[+t.dataset.r],rk=r.racks[+t.dataset.k],i=t.dataset.i==='new'?lv.items.length-1:t.dataset.i;
  refocus('qty-'+r.row+'-'+rk.rack+'-'+lv.level+'-'+i);
});

root.addEventListener('input',function(e){
  var t=e.target,a=t.dataset.act;
  if(a==='xqty'){xfer.qty=t.value;xfer.err='';xfer.msg='';refreshTransfer();return}
  if(a==='rcount'){recv.count=t.value;recv.err='';recv.confirmed=false;refreshRecv(true);return}
  if(a==='rqty'){recv.qtys[+t.dataset.i]=t.value;var ce0=document.getElementById('rv-cerr');if(ce0)ce0.textContent='';refreshRecv();return}
  if(a==='rrt'){recv.routings[+t.dataset.i]=t.value;var ce0=document.getElementById('rv-cerr');if(ce0)ce0.textContent='';refreshRecv();return}
  if(a==='rdate'){recv.date=t.value||today();refreshRecv();return}
  if(a==='mused'){mach.used=t.value;mach.err='';if(mach.confirmed){mach.confirmed=false;step('mr-step',true);refreshReturn()}var ce1=document.getElementById('mr-cerr');if(ce1)ce1.textContent='';return}
  if(!canEdit())return;
  if(a==='qty'){
    var it=lvOf(t).items[+t.dataset.i];if(!it)return;
    it.qty=t.value===''?'':Math.max(0,num(t.value));changed();
    var T=totals(),view=document.getElementById('view'),tmp=document.createElement('div');tmp.innerHTML=racking(T);
    var oldHead=view.querySelector('.rowhead'),newHead=tmp.querySelector('.rowhead');if(oldHead&&newHead)oldHead.replaceWith(newHead);
    var oldChips=view.querySelector('.rowpick'),newChips=tmp.querySelector('.rowpick');if(oldChips&&newChips)oldChips.replaceWith(newChips);
  }else if(a==='pt'){
    var S=sec(t.dataset.s),pi=S&&S.rows[+t.dataset.r].racks[+t.dataset.k].levels[+t.dataset.l].items[+t.dataset.i];if(!pi)return;
    pi[t.dataset.f]=t.value;changed();
  }else if(a==='pf'){
    var p=part(t.dataset.p),f=t.dataset.f;if(!p)return;
    p[f]=t.type==='number'?(t.value===''?'':Math.max(0,num(t.value))):t.value;changed();
    if(f==='qtyPerPallet'||f==='number'){var id=t.id,pos=t.selectionStart;render();var n=document.getElementById(id);if(n){n.focus();try{if(pos!=null)n.setSelectionRange(pos,pos)}catch(x){}}}
  }
});

root.addEventListener('submit',function(e){
  var f=e.target;
  if(f.id==='add-user-form'){
    e.preventDefault();
    var id=document.getElementById('nu-id').value.trim(),role=document.getElementById('nu-role').value,pk=document.getElementById('nu-pk').value;
    adminDo(api('POST','/api/admin/users',{userId:id,role:role,passkey:pk}).then(function(){admin.created={id:id,pk:pk}}),'Added '+id+'.');
  }else if(f.id==='account-form'){
    e.preventDefault();
    var msg=document.getElementById('acc-msg'),cur=document.getElementById('acc-cur').value,n1=document.getElementById('acc-new').value,n2=document.getElementById('acc-new2').value;
    if(n1!==n2){msg.textContent='The new passkeys do not match.';return}
    api('POST','/api/me/passkey',{current:cur,next:n1}).then(function(){ui.account=false;render();var s=document.querySelector('.status');if(s)s.textContent='Passkey updated'})
      .catch(function(x){if(!x.silent)msg.textContent=x.message});
  }
});

/* ---------- boot ---------- */
api('GET','/api/me').then(function(j){me=j.user;return start()}).catch(function(x){if(!x.silent)showLogin('')});
})();
