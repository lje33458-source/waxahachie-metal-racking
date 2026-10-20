(function(){
'use strict';
var root=document.getElementById('app-root');
var me=null;            // {id, role}
var server=null;        // last data loaded/saved from the server
var state=null;         // working copy being edited
var dirty=false,saving=false,newer=null,saveErr='';
var ui={tab:'hq',rows:{},armed:null,account:false}; // tab is a section key, 'master', 'transfer', 'machines' or 'admin'; rows holds the picked row per section
var MACHINES=['EMK','EMLK','P4','L5'];
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
function canEdit(){return me&&me.role!=='viewer'}
function isAdmin(){return me&&me.role==='admin'}
function dis(){return canEdit()?'':' disabled'}
function sec(k){k=k||ui.tab;for(var i=0;i<state.sections.length;i++)if(state.sections[i].key===k)return state.sections[i];return null}
function rows(){var s=sec();return s?s.rows:[]}
function rowKey(s,r){return s.key+'|'+r.row}
function sameRow(a,b){return a!=null&&b!=null&&String(a)===String(b)}
function eachLevel(fn){state.sections.forEach(function(s){s.rows.forEach(function(r){r.racks.forEach(function(rk){rk.levels.forEach(function(lv){fn(lv,s,r)})})})})}
function store(k,v){try{if(v===undefined)localStorage.removeItem(k);else localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
function load(k){try{var v=localStorage.getItem(k);return v?JSON.parse(v):null}catch(e){return null}}
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
  return api('GET','/api/data').then(function(d){
    server=d;state=clone({parts:d.parts,sections:d.sections});dirty=false;newer=null;saveErr='';
    var pref=load('wmr-ui:'+me.id)||{};
    ui.tab=pref.tab||'hq';if(ui.tab==='racking')ui.tab='hq';
    if((ui.tab==='admin'&&!isAdmin())||(['admin','master','transfer','machines'].indexOf(ui.tab)<0&&!sec()))ui.tab='hq';
    ui.rows=pref.rows||{};if(pref.row!=null&&ui.rows.hq==null)ui.rows.hq=pref.row;
    if(location.hash==='#master')ui.tab='master';
    var draft=load('wmr-draft:'+me.id);
    if(draft&&draft.base===server.version&&canEdit()&&draft.state&&Array.isArray(draft.state.sections)){state=draft.state;dirty=true}
    else store('wmr-draft:'+me.id);
    render();
    if(ui.tab==='admin')loadAdmin();
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
    '<div class="top-right"><div class="userbar">Signed in as <b>'+esc(me.id)+'</b> <span class="role '+esc(me.role)+'">'+esc(me.role)+'</span> · '+
      '<button class="linkbtn" data-act="account">Change passkey</button> · <button class="linkbtn" data-act="logout">Sign out</button></div>'+
    '<div class="savebar" id="savebar"></div></div></header>'+
    (ui.account?accountPanel():'')+
    (newer?'<div class="banner" role="status"><span><b>'+esc(newer.savedBy||'Someone')+'</b> saved a newer version at '+esc(when(newer.savedAt))+'. '+
      (dirty?'Your unsaved changes were made on the older version. Load the latest to continue; your edits will be discarded.':'')+'</span>'+
      '<button class="btn" data-act="reload">Load latest</button></div>':'')+
    '<nav class="tabs" role="tablist">'+
      state.sections.map(function(s){return tab(s.key,esc(s.name))}).join('')+tab('master','Master')+tab('transfer','Transfer Material')+tab('machines','Machine Material')+(isAdmin()?tab('admin','Admin'):'')+
    '</nav>'+
    '<section id="view">'+(ui.tab==='master'?master(T):ui.tab==='transfer'?transferView():ui.tab==='machines'?machinesView():ui.tab==='admin'?adminView():racking(T))+'</section>';
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
        h+='</select><input id="qty-'+id+'" class="num" type="number" inputmode="numeric" min="0" step="1" data-act="qty" '+d+' aria-label="Quantity at '+addr+'" value="'+(it&&it.qty!==''&&it.qty!=null?esc(it.qty):'')+'"'+(it&&it.part&&canEdit()?'':' disabled placeholder="Qty"')+'>';
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
  h+=palletSheet();
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
  h+='</tbody></table></div></div></div>';
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
  h+='<div class="panel"><div class="panel-h"><h3>'+esc(partName(p))+' on the racking</h3><p>'+(q?'Green pallets cover '+fmt(q)+' on their own. Yellow pallets have less; pick a second pallet to make up the rest. Red pallets can\'t make up the rest. Up to '+MAX_PALLETS+' pallets.':'Enter the quantity requested to choose pallets.')+'</p></div><div class="scroll"><table class="xfer"><thead><tr><th style="width:44px"></th><th>Date received</th><th>Part Number</th><th>Routing #</th><th>Location</th><th class="r">Quantity</th></tr></thead><tbody>';
  if(!list.length)h+='<tr><td colspan="6" class="empty-note">No pallets of this material are on the racking.</td></tr>';
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
      '<td class="num">'+esc(day(x.received))+(i<2?' <span class="rec">Recommended</span>':'')+'</td><td>'+esc(partName(p))+'</td><td class="num">'+esc(x.routing)+'</td><td><span class="tagl inline">'+esc(x.loc)+'</span></td><td class="r num"><b>'+fmt(x.qty)+'</b></td></tr>';
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
  h+='</div><div class="tablefoot">';
  if(!canEdit())h+='<p class="dim">Your account can view but not transfer material.</p>';
  else if(dirty)h+='<p class="err">Save or undo your racking changes before transferring.</p>';
  else h+='<button class="btn primary" data-act="xgo"'+(!xfer.machine||xfer.busy?' disabled':'')+'>'+(xfer.busy?'Transferring…':xfer.machine?'Transfer '+P.list.length+' pallet'+(P.list.length>1?'s':'')+' to '+xfer.machine:'Choose a machine')+'</button>';
  h+='</div></div>';
  if(xfer.machine)h+='<div class="panel"><div class="panel-h"><h3>Ready for print</h3><p>Pick sheet for this transfer. It fits on one 8.5 × 11 in page.</p><button class="btn" data-act="xprint">Print</button></div><div class="sheet-wrap">'+pickSheet(p,q,P)+'</div></div>';
  return h;
}
// One-page pick sheet: each rack row holding a selected pallet drawn as a grid (racks across, levels top to bottom), then the pick list.
function pickSheet(p,q,P){
  var num_={};P.list.forEach(function(x,i){num_[x.section+'|'+x.addr]=i+1});
  var h='<div class="sheet"><div class="sheet-h"><div><b>Material transfer</b><span>'+esc(when(new Date().toISOString()))+' · '+esc(me.id)+'</span></div><div class="to">To <b>'+esc(xfer.machine)+'</b></div></div>';
  h+='<p class="sheet-part"><b>'+esc(partName(p))+'</b>'+(p.description?' · '+esc(p.description):'')+'</p>';
  h+='<div class="sheet-racks">';
  state.sections.forEach(function(s){s.rows.forEach(function(r){
    if(!P.list.some(function(x){return x.section===s.key&&String(x.row)===String(r.row)}))return;
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
  h+='</div><table class="sheet-list"><thead><tr><th>#</th><th>Location</th><th>Part Number</th><th>Routing #</th><th>Received</th><th class="r">Quantity</th><th>Machine</th><th>Done</th></tr></thead><tbody>';
  P.list.forEach(function(x,i){h+='<tr><td>'+(i+1)+'</td><td><b>'+esc(x.loc)+'</b></td><td>'+esc(partName(p))+'</td><td>'+esc(x.routing)+'</td><td>'+esc(day(x.received))+'</td><td class="r">'+fmt(x.qty)+'</td><td>'+esc(xfer.machine)+'</td><td><span class="box"></span></td></tr>'});
  h+='</tbody><tfoot><tr><td colspan="5">'+P.list.length+' pallet'+(P.list.length>1?'s':'')+' · requested '+fmt(q)+'</td><td class="r">'+fmt(P.total)+'</td><td>'+esc(xfer.machine)+'</td><td></td></tr></tfoot></table></div>';
  return h;
}
function printSheet(){
  var src=document.querySelector('#xf-results .sheet');if(!src)return;
  var pr=document.getElementById('print-root');
  if(!pr){pr=document.createElement('div');pr.id='print-root';document.body.appendChild(pr)}
  pr.innerHTML=src.outerHTML;
  window.print();
}
function refreshTransfer(){var el=document.getElementById('xf-results');if(el)el.innerHTML=transferResults()}
function doTransfer(){
  var q=xferQty(),P=picked(pallets(xfer.part));
  if(!q||P.total<q||!xfer.machine||xfer.busy||dirty||!canEdit())return;
  xfer.busy=true;xfer.err='';xfer.msg='';refreshTransfer();
  var m=xfer.machine,name=partName(part(xfer.part)||{});
  api('POST','/api/transfer',{part:xfer.part,requested:q,machine:m,pallets:P.list.map(function(x){return {section:x.section,row:x.row,rack:x.rack,level:x.level,item:x.item,qty:x.qty}})})
    .then(function(d){
      server=d;state=clone({parts:d.parts,sections:d.sections});newer=null;
      xfer={part:xfer.part,qty:'',picks:[],machine:null,busy:false,err:'',msg:'Moved '+P.list.length+' pallet'+(P.list.length>1?'s':'')+' ('+fmt(P.total)+' × '+name+') from '+P.list.map(function(x){return x.loc}).join(', ')+' to '+m+'.'};
      render();
    })
    .catch(function(x){xfer.busy=false;if(x.silent)return;xfer.err=x.message;reloadLatest()});
}
function machinesView(){
  var M=server.machines||{},tot={},grand=0;
  MACHINES.forEach(function(m){tot[m]=0;state.parts.forEach(function(p){tot[m]+=num((M[m]||{})[p.k])});grand+=tot[m]});
  var h='<div class="stack"><div class="kpis">';
  MACHINES.forEach(function(m){h+='<div class="kpi"><span class="label">'+m+'</span><b class="num">'+fmt(tot[m])+'</b></div>'});
  h+='</div><div class="panel"><div class="panel-h"><h3>Machine material</h3></div><div class="scroll"><table class="matrix"><thead><tr><th>Material type</th>';
  MACHINES.forEach(function(m){h+='<th class="r">'+m+'</th>'});
  h+='<th class="r">Total</th></tr></thead><tbody>';
  var any=false;
  state.parts.forEach(function(p){
    var row=0;MACHINES.forEach(function(m){row+=num((M[m]||{})[p.k])});if(!row)return;any=true;
    h+='<tr><td>'+esc(partName(p))+'</td>';
    MACHINES.forEach(function(m){var v=num((M[m]||{})[p.k]);h+='<td class="r num'+(v?'':' zero')+'">'+(v?fmt(v):'–')+'</td>'});
    h+='<td class="r num"><b>'+fmt(row)+'</b></td></tr>';
  });
  if(!any)h+='<tr><td colspan="'+(MACHINES.length+2)+'" class="empty-note">No material has been transferred to a machine yet.</td></tr>';
  h+='</tbody>'+(any?'<tfoot><tr><td>All material</td>'+MACHINES.map(function(m){return '<td class="r num">'+fmt(tot[m])+'</td>'}).join('')+'<td class="r num">'+fmt(grand)+'</td></tr></tfoot>':'')+'</table></div></div>';
  var log=(server.transfers||[]).slice(0,50);
  h+='<div class="panel"><div class="panel-h"><h3>Recent transfers</h3></div><div class="scroll"><table class="log"><thead><tr><th>When</th><th>User</th><th>Material type</th><th class="r">Qty</th><th>From</th><th>To</th></tr></thead><tbody>';
  if(!log.length)h+='<tr><td colspan="6" class="empty-note">No transfers yet.</td></tr>';
  log.forEach(function(e){var p=part(e.part);h+='<tr><td class="dim">'+esc(when(e.at))+'</td><td>'+esc(e.by)+'</td><td>'+esc(p?partName(p):(e.partNumber||e.partId))+'</td><td class="r num">'+fmt(e.qty)+'</td><td>'+esc(e.from)+'</td><td><b>'+esc(e.machine)+'</b></td></tr>'});
  h+='</tbody></table></div></div></div>';
  return h;
}

// Every pallet on the racking with its routing number and date received, in racking order.
function palletSheet(){
  var multi=state.sections.length>1,n=0;
  var h='<div class="panel"><div class="panel-h"><h3>Pallet tracking</h3><p>Each pallet on the racking. Routing numbers and dates received were filled with placeholders; type over them with the real values and save.</p></div><div class="scroll"><table class="tracking"><thead><tr>'+
    '<th>Location</th><th style="min-width:190px">Part Number</th><th class="r">Qty</th><th style="min-width:130px">Routing #</th><th style="min-width:150px">Date received</th></tr></thead><tbody>';
  state.sections.forEach(function(s){s.rows.forEach(function(r,ri){r.racks.forEach(function(rk,ki){rk.levels.forEach(function(lv,li){lv.items.forEach(function(it,ii){
    var p=part(it.part);if(!p)return;n++;
    var loc=r.row+'-'+rk.rack+'-'+lv.level,d='data-s="'+esc(s.key)+'" data-r="'+ri+'" data-k="'+ki+'" data-l="'+li+'" data-i="'+ii+'"';
    h+='<tr><td><span class="tagl inline">'+esc((multi?s.name+' ':'')+loc)+'</span></td><td>'+esc(partName(p))+'</td><td class="r num">'+fmt(num(it.qty))+'</td>'+
      '<td><input data-act="pt" data-f="routing" '+d+' value="'+esc(it.routing)+'" aria-label="Routing number at '+esc(loc)+'"'+dis()+'></td>'+
      '<td><input type="date" data-act="pt" data-f="received" '+d+' value="'+esc(it.received)+'" aria-label="Date received at '+esc(loc)+'"'+dis()+'></td></tr>';
  })})})})});
  if(!n)h+='<tr><td colspan="5" class="empty-note">No pallets on the racking.</td></tr>';
  return h+'</tbody></table></div></div>';
}

/* ---------- admin ---------- */
function loadAdmin(){
  return Promise.all([api('GET','/api/admin/users'),api('GET','/api/admin/audit')]).then(function(r){
    admin.users=r[0].users;admin.log=r[1].entries;if(ui.tab==='admin')render();
  }).catch(function(x){if(!x.silent){admin.err=x.message;render()}});
}
var ACTIONS={'login':'Signed in','login-failed':'Failed sign-in','save':'Saved racking','create-user':'Added user','update-user':'Changed user','delete-user':'Deleted user','change-passkey':'Changed own passkey','transfer':'Transferred material'};
function adminView(){
  var h='<div class="stack">';
  h+='<form class="panel" id="add-user-form"><div class="panel-h"><h3>Add user</h3></div>'+
    '<div class="formrow"><div class="field"><label for="nu-id">User ID</label><input id="nu-id" autocomplete="off" autocapitalize="none" spellcheck="false" required pattern="[A-Za-z0-9._\\-]{2,40}" title="2–40 letters, numbers, dots, dashes or underscores"></div>'+
    '<div class="field"><label for="nu-role">Role</label><select id="nu-role"><option value="editor">Editor · can edit and save</option><option value="viewer">Viewer · read only</option><option value="admin">Admin · can also manage users</option></select></div>'+
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
      '<td><select data-act="setrole" data-u="'+esc(u.id)+'" aria-label="Role for '+esc(u.id)+'">'+['viewer','editor','admin'].map(function(r){return '<option value="'+r+'"'+(u.role===r?' selected':'')+'>'+r[0].toUpperCase()+r.slice(1)+'</option>'}).join('')+'</select></td>'+
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
  admin.log.slice(0,100).forEach(function(e){
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
  if(a==='tab'){ui.tab=t.dataset.v;ui.armed=null;saveUi();render();refocus('tab-'+ui.tab);if(ui.tab==='admin')loadAdmin()}
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
});

root.addEventListener('change',function(e){
  var t=e.target;
  if(t.dataset.act==='xpart'){xfer.part=t.value;xfer.picks=[];xfer.machine=null;xfer.err='';xfer.msg='';refreshTransfer();return}
  if(t.dataset.act==='setrole'){adminDo(api('PATCH','/api/admin/users/'+encodeURIComponent(t.dataset.u),{role:t.value}),t.dataset.u+' is now '+t.value+'.');return}
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
