(function(){
"use strict";

/* ==========================================================================
   CONFIGURAÇÃO DA PLANILHA NO GOOGLE SHEETS
   ========================================================================== */
var URL_GOOGLE_SCRIPT = "https://script.google.com/macros/s/AKfycby8thnuRK9J_ScgTCqo3g8QWRFfArN8Zdy-KPgrOvQCydR3A6P70kMikQhjNH3X3Xi3YA/exec";
var SENHA_SERVIDOR = "1234"; // temporário; altere no app e no Apps Script
var SYNC_INTERVAL_MS = 5000;
var SYNC_STATE_ID = "estado-conferencia-compartilhado";
var syncApplying = false;
var syncStarted = false;
var syncLastLocal = 0;
var syncLastRemote = 0;
var syncTimer = null;
var syncSaveTimer = null;
var syncDeviceId = (function(){
  try {
    var k="conferencia-device-id-v1", v=localStorage.getItem(k);
    if(!v){v=uid();localStorage.setItem(k,v);}
    return v;
  } catch(e){return uid();}
})();

var KEY="conferencia-carga-v1";
var app=document.getElementById("app");
var overlays=document.getElementById("overlays");
var pdfIn=document.getElementById("pdfIn");
var photoIn=document.getElementById("photoIn");

function setPdfWorker(){try{if(window.pdfjsLib&&window.__pdfWorker)pdfjsLib.GlobalWorkerOptions.workerSrc=window.__pdfWorker;}catch(e){}}

/* ---------- estado ---------- */
var S={step:"setup",orderId:"",orderName:"",conferente:"",repConf:"",draft:[],items:[],clients:[],openClient:null,editC:-1,busca:"",openId:null,zoom:null,confirmReset:false,confirmFinal:false,reportDate:""};
var sheet={photo:null,qty:""};
var warnedStorage=false;

function uid(){return Math.random().toString(36).slice(2,10);}
function r3(x){return Math.round(x*1000)/1000;}
function fmt(n){return Number(n).toLocaleString("pt-BR",{maximumFractionDigits:3});}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function loaded(it){return r3(it.entries.reduce(function(a,e){return a+e.qty;},0));}
function falta(it){return r3(Math.max(0,it.ordered-loaded(it)));}
function parseNum(s){
  s=String(s).trim().replace(/\s/g,"");
  if(!s)return NaN;
  if(/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s))return parseFloat(s.replace(/\./g,"").replace(",","."));
  if(s.indexOf(",")>-1)return parseFloat(s.replace(/\./g,"").replace(",","."));
  return parseFloat(s);
}


/* ---------- sincronização central (Google Apps Script) ---------- */
function syncJsonp(params){
  return new Promise(function(resolve,reject){
    if(!URL_GOOGLE_SCRIPT){reject(new Error("URL do Apps Script não configurada"));return;}
    var cb="__ccSync_"+uid()+"_"+Date.now();
    var script=document.createElement("script");
    var timer=setTimeout(function(){cleanup();reject(new Error("Tempo esgotado ao consultar servidor"));},15000);
    function cleanup(){clearTimeout(timer);try{delete window[cb];}catch(e){window[cb]=undefined;}if(script.parentNode)script.parentNode.removeChild(script);}
    window[cb]=function(data){cleanup();resolve(data);};
    params=params||{};params.callback=cb;
    var q=Object.keys(params).map(function(k){return encodeURIComponent(k)+"="+encodeURIComponent(params[k]);}).join("&");
    script.onerror=function(){cleanup();reject(new Error("Falha ao consultar Google Apps Script"));};
    script.src=URL_GOOGLE_SCRIPT+"?"+q;
    document.head.appendChild(script);
  });
}
function syncPost(payload){
  if(!URL_GOOGLE_SCRIPT)return Promise.resolve();
  payload.senha=SENHA_SERVIDOR;
  return fetch(URL_GOOGLE_SCRIPT,{
    method:"POST",mode:"no-cors",
    headers:{"Content-Type":"text/plain;charset=utf-8"},
    body:JSON.stringify(payload)
  }).catch(function(err){console.warn("Sincronização: falha de envio",err);});
}
function syncStatePayload(){
  // Sheets sincroniza quantidades e dados; fotos/blob ficam locais neste MVP.
  var state={
    step:S.step,orderId:S.orderId,orderName:S.orderName,conferente:S.conferente,
    draft:S.draft,items:S.items,clients:S.clients,guiaId:S.guiaId||"",
    openClient:S.openClient||null,updatedAt:Date.now(),deviceId:syncDeviceId
  };
  return JSON.parse(JSON.stringify(state,function(k,v){
    if(k==="photo"||k==="foto"||k==="fotoData"||k==="blob")return undefined;
    if(typeof Blob!=="undefined"&&v instanceof Blob)return undefined;
    return v;
  }));
}
function syncQueueState(){
  if(syncApplying||!URL_GOOGLE_SCRIPT)return;
  syncLastLocal=Date.now();
  clearTimeout(syncSaveTimer);
  syncSaveTimer=setTimeout(function(){
    syncPost({acao:"syncState",id:SYNC_STATE_ID,updatedAt:syncLastLocal,state:syncStatePayload()});
  },700);
}
function syncPushRecord(rec){
  if(syncApplying||!rec||!rec.id)return;
  // photos/blobs remain local; records and quantities are synced centrally.
  var clean;
  try{clean=JSON.parse(JSON.stringify(rec,function(k,v){
    if(k==="foto"||k==="photo"||k==="fotoData"||k==="blob")return undefined;
    if(typeof Blob!=="undefined"&&v instanceof Blob)return undefined;
    return v;
  }));}catch(e){return;}
  syncPost({acao:"syncRecord",id:String(clean.id),record:clean,updatedAt:Date.now()});
}
function syncApplyState(state,updatedAt){
  if(!state||!updatedAt||updatedAt<=syncLastRemote)return;
  if(Date.now()-syncLastLocal<4000)return; // evita substituir edição local recente
  syncLastRemote=updatedAt;
  syncApplying=true;
  try{
    S.step=state.step||"setup";S.orderId=state.orderId||"";S.orderName=state.orderName||"";
    S.conferente=state.conferente||"";S.draft=state.draft||[];S.items=state.items||[];
    S.clients=state.clients||[];S.guiaId=state.guiaId||"";S.openClient=state.openClient||null;
    localStorage.setItem(KEY,JSON.stringify(state));
    render();
  }catch(e){console.warn("Não foi possível aplicar estado remoto",e);}
  finally{syncApplying=false;}
}
function syncPull(){
  if(!URL_GOOGLE_SCRIPT||syncApplying)return;
  syncJsonp({acao:"syncList",senha:SENHA_SERVIDOR}).then(function(data){
    if(!data||data.status!=="sucesso")return;
    syncApplying=true;
    var records=data.records||[];
    var chain=Promise.resolve();
    records.forEach(function(item){
      if(item&&item.record&&item.record.id){
        chain=chain.then(function(){
          return dbGet(item.record.id).then(function(local){
            if(!local||Number(item.updatedAt||0)>Number(local._syncUpdatedAt||0)){
              item.record._syncUpdatedAt=Number(item.updatedAt||Date.now());
              return dbPutLocal(item.record);
            }
          });
        });
      }
    });
    chain.then(function(){
      syncApplying=false;
      if(data.state)syncApplyState(data.state.state,data.state.updatedAt);
      loadInfo();
    }).catch(function(){syncApplying=false;});
  }).catch(function(err){console.warn("Sincronização: consulta falhou",err);});
}
function dbPutLocal(rec){return idbDo("readwrite",function(st){return st.put(rec);});}
function startSync(){
  if(syncStarted||!URL_GOOGLE_SCRIPT)return;
  syncStarted=true;
  syncPull();
  syncTimer=setInterval(syncPull,SYNC_INTERVAL_MS);
}

function save(){
  try{
    localStorage.setItem(KEY,JSON.stringify({step:(S.step==="report"||S.step==="ajustes")?(S.items.length?"check":"setup"):S.step,orderId:S.orderId,orderName:S.orderName,conferente:S.conferente,draft:S.draft,items:S.items,clients:S.clients,guiaId:S.guiaId||"",openClient:S.openClient||null}));
  }catch(e){
    if(!warnedStorage){warnedStorage=true;toast("Memória do navegador cheia. Finalize e salve a carga atual.");}
  }
  syncQueueState();
}
function restore(){
  try{
    var raw=localStorage.getItem(KEY);
    if(!raw)return;
    var d=JSON.parse(raw);
    if(d&&d.items){S.step=d.step||"setup";S.orderId=d.orderId||"";S.orderName=d.orderName||"";S.conferente=d.conferente||"";S.draft=d.draft||[];S.items=d.items||[];S.clients=d.clients||[];S.guiaId=d.guiaId||"";S.openClient=d.openClient||null;
      if(S.items.length&&!S.clients.length){S.clients=[{id:"c0",code:"",name:"Sem cliente",fantasia:"",address:"",obs:"",nfs:"",expected:0}];S.items.forEach(function(i){i.cid="c0";});}
      if(S.draft.length&&!S.draft[0].items)S.draft=[{code:"",name:"",fantasia:"",address:"",obs:"",nfs:"",expected:0,items:S.draft}];}
  }catch(e){}
}

/* ---------- senha, dados e relatório ---------- */
var SKEY="conferencia-senha-v1",SESS="conferencia-sessao-v1",NKEY="conferencia-conferentes-v1";
var unlocked=false;
var report={loading:false,recs:[],err:"",names:[]};
var reportToken=0;
function pad(n){return n<10?"0"+n:""+n;}
function todayStr(){var d=new Date();return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());}
function nowHour(){var d=new Date();return pad(d.getHours())+":"+pad(d.getMinutes());}
function brDate(s){return String(s).split("-").reverse().join("/");}

/* SHA-256 */
function sha256(ascii){
  function rr(v,a){return (v>>>a)|(v<<(32-a));}
  var mp=Math.pow,mw=mp(2,32),i,j,result="",words=[],bl=ascii.length*8;
  var hash=sha256.h=sha256.h||[],k=sha256.k=sha256.k||[],pc=k.length,comp={};
  for(var c=2;pc<64;c++){
    if(!comp[c]){
      for(i=0;i<313;i+=c)comp[i]=c;
      hash[pc]=(mp(c,0.5)*mw)|0;k[pc++]=(mp(c,1/3)*mw)|0;
    }
  }
  ascii+="\x80";
  while(ascii.length%64-56)ascii+="\x00";
  for(i=0;i<ascii.length;i++){
    j=ascii.charCodeAt(i);
    if(j>>8)return "";
    words[i>>2]|=j<<((3-i)%4)*8;
  }
  words[words.length]=((bl/mw)|0);
  words[words.length]=bl;
  for(j=0;j<words.length;){
    var w=words.slice(j,j+=16),old=hash;
    hash=hash.slice(0,8);
    for(i=0;i<64;i++){
      var w15=w[i-15],w2=w[i-2],a=hash[0],e=hash[4];
      var t1=hash[7]+(rr(e,6)^rr(e,11)^rr(e,25))+((e&hash[5])^((~e)&hash[6]))+k[i]+(w[i]=(i<16)?w[i]:(w[i-16]+(rr(w15,7)^rr(w15,18)^(w15>>>3))+w[i-7]+(rr(w2,17)^rr(w2,19)^(w2>>>10)))|0);
      var t2=(rr(a,2)^rr(a,13)^rr(a,22))+((a&hash[1])^(a&hash[2])^(hash[1]&hash[2]));
      hash=[(t1+t2)|0].concat(hash);
      hash[4]=(hash[4]+t1)|0;
    }
    for(i=0;i<8;i++)hash[i]=(hash[i]+old[i])|0;
  }
  for(i=0;i<8;i++)for(j=3;j+1;j--){var b=(hash[i]>>(j*8))&255;result+=((b<16)?0:"")+b.toString(16);}
  return result;
}
function hashSenha(pass,salt){
  var h=sha256(unescape(encodeURIComponent(salt+pass)));
  for(var i=0;i<2000;i++)h=sha256(h+salt);
  return h;
}
function getSenha(){try{return JSON.parse(localStorage.getItem(SKEY)||"null");}catch(e){return null;}}
function setSenha(pass){
  var salt=uid()+uid()+uid();
  try{localStorage.setItem(SKEY,JSON.stringify({salt:salt,hash:hashSenha(pass,salt)}));return true;}catch(e){return false;}
}
function checkSenha(pass){var r=getSenha();return !!r&&hashSenha(pass,r.salt)===r.hash;}

/* banco de dados do navegador (IndexedDB) */
var idbP=null;
function idb(){
  if(!idbP)idbP=new Promise(function(res,rej){
    if(!window.indexedDB){rej(new Error("sem IndexedDB"));return;}
    var r=indexedDB.open("conferencia-carga",1);
    r.onupgradeneeded=function(){r.result.createObjectStore("cargas",{keyPath:"id"});};
    r.onsuccess=function(){res(r.result);};
    r.onerror=function(){rej(r.error);};
  });
  return idbP;
}
function idbDo(mode,fn){
  return idb().then(function(db){
    return new Promise(function(res,rej){
      var tx=db.transaction("cargas",mode),st=tx.objectStore("cargas"),out=fn(st);
      tx.oncomplete=function(){res(out&&out.result);};
      tx.onerror=tx.onabort=function(){rej(tx.error);};
    });
  });
}
function dbPut(rec){
  return idbDo("readwrite",function(s){return s.put(rec);}).then(function(){
    syncPushRecord(rec); return rec;
  });
}
function dbAll(){return idbDo("readonly",function(s){return s.getAll();});}
function dbGet(id){return idbDo("readonly",function(s){return s.get(id);});}

/* guias salvas e situação de cada cliente */
var info={guias:[],last:{}};
function ensureKeys(){S.draft.forEach(function(c){if(!c.key)c.key=uid();});}
function loadInfo(){
  return dbAll().then(function(all){
    all=all||[];
    info.guias=all.filter(function(r){return r.kind==="guia";}).sort(function(a,b){return b.ts-a.ts;});
    info.last={};
    all.filter(function(r){return r.kind!=="guia"&&r.guiaId;}).sort(function(a,b){return a.ts-b.ts;}).forEach(function(r){
      recClients(r).forEach(function(c){if(c.key)info.last[r.guiaId+"|"+c.key]={c:c,rec:r};});
    });
  }).catch(function(){}).then(function(){
    if(S.step==="setup"){renderDraft();renderGuiaSel();}
    else if(S.step==="report")renderReport();
  });
}

function stOf(gid,key){
  var x=info.last[gid+"|"+key];
  if(!x)return {k:"nao",label:"Falta conferir",cls:"none"};
  var f=x.c.items.filter(function(i){return i.falta>0;}).length;
  return f?{k:"falta",label:f+" produto(s) com falta",cls:"warn",x:x}:{k:"ok",label:"Conferido",cls:"ok",x:x};
}
function cleanClient(c){
  return {key:c.key,code:c.code||"",name:(c.name||"").trim(),fantasia:c.fantasia||"",address:c.address||"",obs:c.obs||"",nfs:nfsLimpa(c.nfs).trim(),expected:c.expected||0,
    items:c.items.filter(function(d){return d.name.trim()&&parseNum(d.qty)>0;}).map(function(d){return {code:d.code||"",name:d.name.trim(),unit:(d.unit||"").trim(),ordered:r3(parseNum(d.qty))};})};
}
function saveGuia(){
  if(!S.draft.length)return Promise.resolve();
  ensureKeys();if(!S.guiaId)S.guiaId=uid();
  var rec={id:S.guiaId,kind:"guia",order:(S.orderName||"").trim()||"Sem identificação",ts:Date.now(),date:todayStr(),clients:S.draft.map(cleanClient).filter(function(c){return c.items.length;})};
  save();
  return dbPut(rec).then(loadInfo).catch(function(){toast("Não foi possível guardar a guia neste navegador.");});
}
function abrirGuia(id){
  var g=info.guias.filter(function(x){return x.id===id;})[0];if(!g)return;
  S.guiaId=g.id;S.orderName=g.order;S.editC=-1;S.busca="";S.fil="";
  S.draft=g.clients.map(function(c){return {key:c.key,code:c.code,name:c.name,fantasia:c.fantasia,address:c.address,obs:c.obs,nfs:c.nfs,expected:c.expected,
    items:c.items.map(function(i){return {code:i.code,name:i.name,qty:String(i.ordered).replace(".",","),unit:i.unit};})};});
  save();render();
}

/* entrada */
function renderGate(msg){
  var first=!getSenha();
  app.innerHTML=
    '<div class="intro"><div class="eyebrow">Doca de carregamento</div><h1 class="title">Conferência de Carga</h1>'+
    '<p>'+(first?'Primeiro acesso. Crie a senha de acesso do aplicativo.':'Digite a senha para entrar.')+'</p></div>'+
    '<div class="stack" style="margin-top:16px">'+
    '<div class="field"><label for="gPass">'+(first?'Nova senha':'Senha')+'</label><input class="inp" id="gPass" type="password" autocomplete="'+(first?'new-password':'current-password')+'"></div>'+
    (first?'<div class="field"><label for="gPass2">Repita a senha</label><input class="inp" id="gPass2" type="password" autocomplete="new-password"></div>':'')+
    '<div class="status'+(msg?" err":"")+'" id="gStatus" role="status">'+esc(msg||"")+'</div>'+
    '<button class="btn primary" id="gBtn" data-act="'+(first?'gate-create':'gate-enter')+'" type="button">'+(first?'Criar senha e entrar':'Entrar')+'</button></div>';
}
function unlock(){unlocked=true;try{sessionStorage.setItem(SESS,"1");}catch(e){}render();}
function gateEnter(){
  var p=document.getElementById("gPass").value||"",st=document.getElementById("gStatus");
  if(!p){st.textContent="Digite a senha.";st.className="status err";return;}
  if(checkSenha(p))unlock();else{st.textContent="Senha incorreta.";st.className="status err";}
}
function gateCreate(){
  var p=document.getElementById("gPass").value||"",p2=document.getElementById("gPass2").value||"",st=document.getElementById("gStatus");
  function say(t){st.textContent=t;st.className="status err";}
  if(p.length<4){say("Use pelo menos 4 caracteres.");return;}
  if(p!==p2){say("As duas senhas não são iguais.");return;}
  if(!setSenha(p)){say("Não foi possível guardar a senha neste navegador.");return;}
  unlock();
}
function sair(){unlocked=false;try{sessionStorage.removeItem(SESS);}catch(e){}S.step=S.items.length?"check":"setup";render();}
function startup(){
  try{unlocked=!!getSenha()&&sessionStorage.getItem(SESS)==="1";}catch(e){unlocked=false;}
  render();
  startSync();
}

/* conferentes */
function nomes(){try{return JSON.parse(localStorage.getItem(NKEY)||"[]")||[];}catch(e){return [];}}
function lembrarNome(n){
  var l=nomes().filter(function(x){return x.toLowerCase()!==n.toLowerCase();});l.unshift(n);
  try{localStorage.setItem(NKEY,JSON.stringify(l.slice(0,30)));}catch(e){}
}

/* gravar a carga */
function recClients(rec){return rec.clients||[{code:"",name:"",fantasia:"",nfs:"",items:rec.items||[]}];}
function buildRecord(){
  var clients=S.clients.map(function(c){
    return {key:c.id,code:c.code,name:c.name,fantasia:c.fantasia,nfs:c.nfs,items:itensDe(c.id).map(function(it){
      return {name:it.name,code:it.code||"",unit:it.unit,ordered:it.ordered,loaded:loaded(it),falta:falta(it),
        regs:it.entries.map(function(e){return {qty:e.qty,t:e.t,foto:e.photo};})};
    })};
  });
  var ok=clients.every(function(c){return c.items.every(function(i){return i.falta===0;});});
  return {id:S.orderId||uid(),conferente:(S.conferente||"").trim(),date:todayStr(),hora:nowHour(),ts:Date.now(),order:S.orderName||"Sem identificação",guiaId:S.guiaId||"",complete:ok,clients:clients};
}

/* Envio de resumo legado; sincronização central ocorre em syncPushRecord/syncQueueState. */
function enviarParaGoogleSheets(rec) {
  if (!URL_GOOGLE_SCRIPT) return;
  recClients(rec).forEach(function(c) {
    var comp = 0, fal = 0;
    c.items.forEach(function(i) {
      if (i.falta === 0) comp++; else fal++;
    });
    
    var payload = {
      acao: "salvar",
      senha: SENHA_SERVIDOR,
      ordem: rec.order,
      cliente: c.name,
      notasFiscais: c.nfs,
      situacao: rec.complete ? "Conferido" : "Conferido com falta",
      produtos: c.items.length,
      produtosCompletos: comp,
      produtosComFalta: fal,
      conferente: rec.conferente,
      data: brDate(rec.date),
      hora: rec.hora
    };

    fetch(URL_GOOGLE_SCRIPT, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload)
    }).catch(function(err){ console.error("Erro ao enviar para Google Sheets:", err); });
  });
}

function finalize(){
  var rec=buildRecord(),jobs=[];
  recClients(rec).forEach(function(c){c.items.forEach(function(it){it.regs.forEach(function(r){
    if(typeof r.foto==="string"&&r.foto)jobs.push(fetch(r.foto).then(function(x){return x.blob();}).then(function(b){r.foto=b;}));
  });});});
  Promise.all(jobs).then(function(){
    enviarParaGoogleSheets(rec);
    return dbPut(rec);
  }).then(function(){
    S={step:"setup",orderId:"",orderName:S.orderName,conferente:S.conferente,repConf:"",draft:S.draft,guiaId:S.guiaId,items:[],clients:[],openClient:null,editC:-1,busca:"",fil:"",openId:null,zoom:null,confirmReset:false,confirmFinal:false,reportDate:todayStr(),reportTo:todayStr()};
    save();render();window.scrollTo(0,0);loadInfo();
    toast("Conferência salva e sincronizada!");
  }).catch(function(){
    S.confirmFinal=false;render();
    toast("Não foi possível salvar a carga. Nada foi apagado. Tente de novo.");
  });
}

/* relatório */
function openReport(){
  loadInfo();
  if(!S.reportDate)S.reportDate=todayStr();
  if(!S.reportTo||S.reportTo<S.reportDate)S.reportTo=S.reportDate;
  S.step="report";S.confirmReset=false;S.confirmFinal=false;S.openId=null;
  loadReport();window.scrollTo(0,0);
}

function loadReport(){
  var from=S.reportDate||todayStr(),to=S.reportTo||from,tk=++reportToken;
  report={loading:true,recs:[],err:"",names:[]};
  render();

  dbAll().then(function(all){
    if(tk!==reportToken)return;
    report.recs=(all||[]).filter(function(r){return r.kind!=="guia"&&r.date>=from&&r.date<=to;}).sort(function(a,b){return a.ts-b.ts;}).map(function(r){
      var cls=recClients(r).map(function(c){
        return {name:c.name||"",fantasia:c.fantasia||"",nfs:c.nfs||"",items:c.items.map(function(i){
          return {name:i.name,unit:i.unit||"",ordered:i.ordered,loaded:i.loaded,falta:i.falta,nfotos:(i.regs||[]).filter(function(x){return x.foto;}).length};
        })};
      });
      var ok=cls.every(function(c){return c.items.every(function(i){return i.falta===0;});});
      return {id:r.id,date:r.date,hora:r.hora,conf:r.conferente||"",order:r.order,complete:ok,clients:cls};
    });
    report.names=report.recs.map(function(r){return r.conf;}).filter(function(n,i,a){return n&&a.indexOf(n)===i;}).sort();
  }).catch(function(){
    if(tk===reportToken)report.err="Não foi possível ler os dados guardados.";
  }).then(function(){
    if(tk!==reportToken)return;
    report.loading=false;
    if(S.step==="report")renderReport();
  });
}

function shown(){return report.recs.filter(function(r){return !S.repConf||r.conf===S.repConf;});}
function nPhotos(r){return r.clients.reduce(function(a,c){return a+c.items.reduce(function(b,i){return b+i.nfotos;},0);},0);}
function loadCard(r){
  var np=nPhotos(r);
  return '<div class="load"><div class="load-h"><div style="min-width:0"><b>'+esc(r.order)+'</b><div class="hint mono">'+esc(brDate(r.date))+' '+esc(r.hora)+'</div>'+
    '<div class="hint">Conferente: '+esc(r.conf||"não informado")+'</div></div>'+
    '<span class="pill '+(r.complete?"ok":"warn")+'">'+(r.complete?"Completa":"Com falta")+'</span></div>'+
    r.clients.map(function(c){
      var faltas=c.items.filter(function(i){return i.falta>0;}).length;
      return '<div class="hint" style="margin-top:12px"><b>'+esc(c.name||"Sem cliente")+'</b>'+(c.nfs?' · <span class="mono">NF '+esc(c.nfs)+'</span>':'')+' · '+(faltas?faltas+' com falta':'completo')+'</div>'+
        c.items.map(function(i){
          return '<div class="mini"><span class="n">'+esc(i.name)+'</span><span class="v mono">'+fmt(i.loaded)+' / '+fmt(i.ordered)+' '+esc(i.unit)+
            (i.falta>0?'<br><span class="pill warn">falta '+fmt(i.falta)+'</span>':'')+'</span></div>';
        }).join("");
    }).join("")+
    (np?'<div style="margin-top:10px"><button class="btn small ghost" data-act="photos" data-id="'+esc(r.id)+'" type="button">Ver fotos ('+np+')</button></div>':'')+'</div>';
}
function renderReport(){
  var from=S.reportDate||todayStr(),to=S.reportTo||from,recs=shown();
  var nOk=recs.filter(function(r){return r.complete;}).length;
  var tabs='<div class="actions" style="margin-top:14px"><button class="btn'+(S.repTab==="sit"?"":" primary")+'" data-act="rtab" data-t="feitas" type="button">Conferências feitas</button><button class="btn'+(S.repTab==="sit"?" primary":"")+'" data-act="rtab" data-t="sit" type="button">Situação por cliente</button></div>';
  if(S.repTab==="sit"){renderSituacao(tabs);return;}
  var html='<div class="top"><div class="eyebrow">Relatório</div><h1 class="title">Conferências feitas</h1></div>'+tabs+
    '<div class="actions" style="margin-top:14px"><div class="field"><label for="repDate">De</label><input class="inp" id="repDate" type="date" value="'+esc(from)+'"></div>'+
    '<div class="field"><label for="repTo">Até</label><input class="inp" id="repTo" type="date" value="'+esc(to)+'"></div></div>'+
    '<div class="field" style="margin-top:10px"><label for="repConf">Conferente</label><select class="inp" id="repConf"><option value="">Todos</option>'+
    report.names.map(function(n){return '<option value="'+esc(n)+'"'+(S.repConf===n?" selected":"")+'>'+esc(n)+'</option>';}).join("")+'</select></div>';
  var per=from===to?brDate(from):brDate(from)+" a "+brDate(to);
  if(report.loading)html+='<div class="status" style="margin-top:12px">Carregando cargas...</div>';
  else if(report.err)html+='<div class="banner warn">'+esc(report.err)+'</div>';
  else if(!recs.length)html+='<div class="banner warn">Nenhuma carga salva em '+per+'.</div>';
  else html+='<div class="banner '+(nOk===recs.length?"ok":"warn")+'">'+recs.length+' carga(s) em '+per+': '+nOk+' completa(s)'+(recs.length-nOk?', '+(recs.length-nOk)+' com falta':'')+'.</div>';
  html+=recs.map(loadCard).join("");
  html+='<div class="stack" style="margin-top:16px"><button class="btn primary" data-act="download" type="button"'+(recs.length?'':' disabled')+'>Baixar planilha</button>'+
    '<button class="btn" data-act="rback" type="button">Voltar</button></div>';
  app.innerHTML=html;
}
function guiaSel(){return info.guias.filter(function(x){return x.id===S.repGuia;})[0]||info.guias.filter(function(x){return x.id===S.guiaId;})[0]||info.guias[0];}
function renderSituacao(tabs){
  var g=guiaSel(),html='<div class="top"><div class="eyebrow">Relatório</div><h1 class="title">Situação por cliente</h1></div>'+tabs;
  if(!g){app.innerHTML=html+'<div class="banner warn">Nenhuma guia salva ainda. Anexe o PDF da guia na tela inicial.</div><div class="stack" style="margin-top:16px"><button class="btn" data-act="rback" type="button">Voltar</button></div>';return;}
  var nOk=0,nF=0,nN=0;
  g.clients.forEach(function(c){var k=stOf(g.id,c.key).k;if(k==="ok")nOk++;else if(k==="falta")nF++;else nN++;});
  var vis=g.clients.filter(function(c){return !S.repFil||stOf(g.id,c.key).k===S.repFil;});
  html+='<div class="field" style="margin-top:10px"><label for="repGuia">Guia</label><select class="inp" id="repGuia">'+info.guias.map(function(x){return '<option value="'+esc(x.id)+'"'+(x.id===g.id?" selected":"")+'>'+esc(x.order)+' - '+esc(brDate(x.date))+'</option>';}).join("")+'</select></div>'+
    '<div class="field" style="margin-top:10px"><label for="repFil">Mostrar</label><select class="inp" id="repFil"><option value="">Todos os clientes</option><option value="nao"'+(S.repFil==="nao"?" selected":"")+'>Falta conferir</option><option value="falta"'+(S.repFil==="falta"?" selected":"")+'>Conferidos com falta</option><option value="ok"'+(S.repFil==="ok"?" selected":"")+'>Conferidos completos</option></select></div>'+
    '<div class="banner '+(nOk===g.clients.length?"ok":"warn")+'">'+g.clients.length+' clientes: '+nOk+' conferido(s) completo(s), '+nF+' com falta, '+nN+' falta conferir.</div>'+
    vis.map(function(c){
      var st=stOf(g.id,c.key),x=st.x,np=0;
      var lines=x?x.c.items.map(function(i){np+=(i.regs||[]).filter(function(r){return r.foto;}).length;
          return '<div class="mini"><span class="n">'+esc(i.name)+'</span><span class="v mono">'+fmt(i.loaded)+' / '+fmt(i.ordered)+' '+esc(i.unit)+(i.falta>0?'<br><span class="pill warn">falta '+fmt(i.falta)+'</span>':'')+'</span></div>';}).join("")
        :c.items.map(function(i){return '<div class="mini"><span class="n">'+esc(i.name)+'</span><span class="v mono">'+fmt(i.ordered)+' '+esc(i.unit)+'<br><span class="pill none">falta conferir</span></span></div>';}).join("");
      return '<details class="load"><summary><b>'+esc(c.name)+'</b> <span class="pill '+st.cls+'">'+esc(st.label)+'</span><div class="hint mono">NF '+esc(c.nfs||"-")+'</div>'+
        (x?'<div class="hint">Conferido por '+esc(x.rec.conferente||"não informado")+' em '+esc(brDate(x.rec.date))+' '+esc(x.rec.hora)+'</div>':'')+'</summary>'+lines+
        (np?'<div style="margin-top:10px"><button class="btn small ghost" data-act="photos" data-id="'+esc(x.rec.id)+'" type="button">Ver fotos ('+np+')</button></div>':'')+'</details>';
    }).join("")+
    '<div class="stack" style="margin-top:16px"><button class="btn primary" data-act="download-sit" type="button">Baixar planilha da situação</button><button class="btn" data-act="rback" type="button">Voltar</button></div>';
  app.innerHTML=html;
}
function downloadSituacao(){
  var g=guiaSel();if(!g)return;
  var linhas=[["Ordem","Cliente","Notas fiscais","Situação do cliente","Produto","Unidade","Qtd. da guia","Qtd. conferida","Falta","Situação do produto","Conferente","Data","Hora"]];
  var resumo=[["Ordem","Cliente","Notas fiscais","Situação do cliente","Produtos","Produtos completos","Produtos com falta","Conferente","Data","Hora"]];
  g.clients.forEach(function(c){
    var st=stOf(g.id,c.key),x=st.x,rec=x?x.rec:null;
    var its=x?x.c.items:c.items.map(function(i){return {name:i.name,unit:i.unit,ordered:i.ordered,loaded:"",falta:i.ordered};});
    var comp=0,fal=0;
    its.forEach(function(i){
      var sit=!x?"Falta conferir":(i.falta===0?"Completo":"Falta");
      if(x){if(i.falta===0)comp++;else fal++;}
      linhas.push([g.order,c.name,c.nfs,st.k==="nao"?"Falta conferir":(st.k==="ok"?"Conferido":"Conferido com falta"),i.name,i.unit,i.ordered,i.loaded,i.falta,sit,rec?rec.conferente:"",rec?brDate(rec.date):"",rec?rec.hora:""]);
    });
    resumo.push([g.order,c.name,c.nfs,st.k==="nao"?"Falta conferir":(st.k==="ok"?"Conferido":"Conferido com falta"),its.length,x?comp:"",x?fal:"",rec?rec.conferente:"",rec?brDate(rec.date):"",rec?rec.hora:""]);
  });
  var base="situacao-"+String(g.order).replace(/[^A-Za-z0-9_-]+/g,"-")+"-"+todayStr();
  if(window.XLSX){
    var w1=XLSX.utils.aoa_to_sheet(resumo),w2=XLSX.utils.aoa_to_sheet(linhas);
    w1["!cols"]=[{wch:26},{wch:40},{wch:30},{wch:20},{wch:10},{wch:12},{wch:12},{wch:20},{wch:12},{wch:8}];
    w2["!cols"]=[{wch:26},{wch:40},{wch:30},{wch:20},{wch:42},{wch:9},{wch:12},{wch:14},{wch:9},{wch:16},{wch:20},{wch:12},{wch:8}];
    var wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,w1,"Resumo por cliente");XLSX.utils.book_append_sheet(wb,w2,"Produtos");
    try{XLSX.writeFile(wb,base+".xlsx");toast("Planilha .xlsx gerada.");return;}catch(e){}
  }
  saveBlob(new Blob([csvOf(linhas)],{type:"text/csv;charset=utf-8"}),base+".csv");
  toast("Planilha .csv gerada. Abre no Excel.");
}
function showPhotos(id,btn){
  btn.disabled=true;
  dbGet(id).then(function(rec){
    var urls=[];
    (rec?recClients(rec):[]).forEach(function(c){c.items.forEach(function(i){(i.regs||[]).forEach(function(r){if(r.foto)urls.push(URL.createObjectURL(r.foto));});});});
    if(!urls.length)throw new Error("sem fotos");
    S.gallery=urls;renderOverlays();
  }).catch(function(){toast("Não foi possível abrir as fotos.");}).then(function(){btn.disabled=false;});
}
function saveBlob(blob,name){
  var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;
  document.body.appendChild(a);a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},1500);
}
function csvOf(rows){
  return "﻿"+rows.map(function(r){
    return r.map(function(c){
      var s=typeof c==="number"?String(c).replace(".",","):String(c==null?"":c);
      return /[;"\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
    }).join(";");
  }).join("\r\n");
}
function downloadSheet(){
  var recs=shown();if(!recs.length)return;
  var from=S.reportDate||todayStr(),to=S.reportTo||from;
  var linhas=[["Data","Hora","Conferente","Ordem","Cliente","Notas fiscais","Produto","Unidade","Qtd. da ordem","Qtd. carregada","Falta","Situação"]];
  var tot={},ordem=[];
  recs.forEach(function(r){r.clients.forEach(function(c){c.items.forEach(function(i){
    linhas.push([brDate(r.date),r.hora,r.conf,r.order,c.name,c.nfs,i.name,i.unit,i.ordered,i.loaded,i.falta,i.falta===0?"Completo":"Falta"]);
    var k=i.name.toLowerCase()+"|"+i.unit.toLowerCase();
    if(!tot[k]){tot[k]={n:i.name,u:i.unit,o:0,l:0};ordem.push(k);}
    tot[k].o=r3(tot[k].o+i.ordered);tot[k].l=r3(tot[k].l+i.loaded);
  });});});
  var base="conferencias-"+from+(to!==from?"_a_"+to:"");
  if(window.XLSX){
    var resumo=[["Produto","Unidade","Qtd. da ordem","Qtd. carregada","Falta"]].concat(ordem.map(function(k){var t=tot[k];return [t.n,t.u,t.o,t.l,r3(Math.max(0,t.o-t.l))];}));
    var w1=XLSX.utils.aoa_to_sheet(linhas),w2=XLSX.utils.aoa_to_sheet(resumo);
    w1["!cols"]=[{wch:12},{wch:8},{wch:22},{wch:26},{wch:38},{wch:30},{wch:42},{wch:9},{wch:14},{wch:15},{wch:9},{wch:12}];
    w2["!cols"]=[{wch:42},{wch:9},{wch:14},{wch:15},{wch:9}];
    var wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,w1,"Conferências");
    XLSX.utils.book_append_sheet(wb,w2,"Total por produto");
try{XLSX.writeFile(wb,base+".xlsx");toast("Planilha .xlsx gerada.");return;}catch(e){}
  }
  saveBlob(new Blob([csvOf(linhas)],{type:"text/csv;charset=utf-8"}),base+".csv");
  toast("Planilha .csv gerada. Abre no Excel.");
}

/* ajustes: senha e backup */
function renderSettings(){
  app.innerHTML='<div class="top"><div class="eyebrow">Aplicativo</div><h1 class="title">Ajustes</h1></div>'+
    '<h2 class="sec-title">Trocar senha</h2><div class="stack">'+
    '<div class="field"><label for="pOld">Senha atual</label><input class="inp" id="pOld" type="password" autocomplete="current-password"></div>'+
    '<div class="field"><label for="pNew">Nova senha</label><input class="inp" id="pNew" type="password" autocomplete="new-password"></div>'+
    '<div class="field"><label for="pNew2">Repita a nova senha</label><input class="inp" id="pNew2" type="password" autocomplete="new-password"></div>'+
    '<div class="status" id="pStatus" role="status"></div>'+
    '<button class="btn" data-act="change-pass" type="button">Trocar senha</button></div>'+
    '<h2 class="sec-title">Cópia de segurança</h2><div class="stack">'+
    '<div class="hint">Os dados ficam guardados neste navegador, neste computador. Baixe uma cópia de vez em quando e guarde em outro lugar.</div>'+
    '<button class="btn" data-act="backup" type="button">Baixar cópia de segurança (.json)</button>'+
    '<button class="btn ghost" data-act="restore" type="button">Restaurar uma cópia</button></div>'+
    '<div class="stack" style="margin-top:22px"><button class="btn danger" data-act="sair" type="button">Sair do aplicativo</button>'+
    '<button class="btn" data-act="rback" type="button">Voltar</button></div>';
}
function changePass(){
  var o=document.getElementById("pOld").value||"",n=document.getElementById("pNew").value||"",n2=document.getElementById("pNew2").value||"",st=document.getElementById("pStatus");
  function say(t,ok){st.textContent=t;st.className="status"+(ok?"":" err");}
  if(!checkSenha(o)){say("A senha atual está incorreta.");return;}
  if(n.length<4){say("Use pelo menos 4 caracteres.");return;}
  if(n!==n2){say("As duas senhas novas não são iguais.");return;}
  if(!setSenha(n)){say("Não foi possível guardar a nova senha.");return;}
  say("Senha trocada.",true);
  ["pOld","pNew","pNew2"].forEach(function(id){document.getElementById(id).value="";});
}
function blobToDataUrl(b){return new Promise(function(res,rej){var f=new FileReader();f.onload=function(){res(f.result);};f.onerror=rej;f.readAsDataURL(b);});}
function doBackup(){
  toast("Preparando a cópia...");
  dbAll().then(function(all){
    return Promise.all((all||[]).map(function(rec){
      var jobs=[];
      recClients(rec).forEach(function(c){c.items.forEach(function(i){(i.regs||[]).forEach(function(r){
        if(r.foto&&typeof r.foto!=="string")jobs.push(blobToDataUrl(r.foto).then(function(u){r.foto=u;}));
      });});});
      return Promise.all(jobs).then(function(){return rec;});
    }));
  }).then(function(recs){
    saveBlob(new Blob([JSON.stringify({app:"conferencia-carga",versao:1,cargas:recs})],{type:"application/json"}),"conferencia-copia-"+todayStr()+".json");
    toast("Cópia de segurança gerada ("+recs.length+" carga(s)).");
  }).catch(function(){toast("Não foi possível gerar a cópia.");});
}
function doRestore(file){
  var fr=new FileReader();
  fr.onerror=function(){toast("Não foi possível abrir o arquivo.");};
  fr.onload=function(){
    var d;try{d=JSON.parse(fr.result);}catch(e){toast("Este arquivo não é uma cópia válida.");return;}
    if(!d||d.app!=="conferencia-carga"||!Array.isArray(d.cargas)){toast("Este arquivo não é uma cópia válida.");return;}
    var n=0;
    d.cargas.reduce(function(p,rec){
      return p.then(function(){
        var jobs=[];
        recClients(rec).forEach(function(c){c.items.forEach(function(i){(i.regs||[]).forEach(function(r){
          if(typeof r.foto==="string"&&r.foto)jobs.push(fetch(r.foto).then(function(x){return x.blob();}).then(function(b){r.foto=b;}));
        });});});
        return Promise.all(jobs).then(function(){return dbPut(rec);}).then(function(){n++;});
      });
    },Promise.resolve()).then(function(){toast(n+" carga(s) restaurada(s).");}).catch(function(){toast("A restauração parou no meio. Tente de novo.");});
  };
  fr.readAsText(file);
}

/* ---------- toast ---------- */
var toastTimer=null;
function toast(msg){
  var t=document.getElementById("toast");
  if(!t){t=document.createElement("div");t.id="toast";t.className="toast";t.setAttribute("role","status");document.body.appendChild(t);}
  t.textContent=msg;t.hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(function(){t.hidden=true;},2800);
}

/* ---------- leitura do PDF ---------- */
function agruparLinhas(items){
  var its=items.slice().sort(function(a,b){return b.y-a.y||a.x-b.x;}),lines=[],cur=null;
  its.forEach(function(it){
    if(!cur||Math.abs(cur.y-it.y)>2.5){cur={y:it.y,items:[]};lines.push(cur);}
    cur.items.push(it);
  });
  lines.forEach(function(l){
    l.items.sort(function(a,b){return a.x-b.x;});
    l.text=l.items.map(function(i){return i.s;}).join(" ").replace(/\s+/g," ").trim();
  });
  return lines;
}
function textoRegiao(items,yTop,yBottom,xMax){
  var sel=items.filter(function(i){return i.y<yTop-1&&i.y>yBottom+1&&(xMax==null||i.x<xMax);});
  return agruparLinhas(sel).map(function(l){return l.text;}).join(" ").replace(/\s+/g," ").trim();
}
function nfsTexto(nfs){
  return nfs.map(function(n){return n.num+(n.tipo?" ("+n.tipo+")":"");}).join(", ");
}
function nfsLimpa(str){
  return String(str||"").replace(/\d[\d.]*\d/g,function(m){return m.replace(/\./g,"");});
}
function parseGuia(pages){
  var out={ordem:"",clientes:[]},cur=null;
  pages.forEach(function(items){
    var lines=agruparLinhas(items);
    function acha(re){for(var i=0;i<lines.length;i++)if(re.test(lines[i].text))return lines[i];return null;}
    var nfl=lines.filter(function(l){return /^NF\s+\d/.test(l.text);});
    var tot=acha(/^Total Itens/),ass=acha(/^Assinatura/),cab=acha(/^C[óo]digo\s+Produto/);
    var tm=tot?/Total Itens:?\s*(\d+)/.exec(tot.text):null;
    var lower=tot?tot.y:(ass?ass.y:0);
    function produtos(topY){
      var res=[];
      agruparLinhas(items.filter(function(i){return i.y<topY-1&&i.y>lower+1;})).forEach(function(l){
        var m=/^(\d[\d.]*)\s+(.+?)\s+(\d+(?:,\d+)?)$/.exec(l.text);
        if(m)res.push({code:m[1],name:m[2],qty:m[3]});
      });
      return res;
    }
    if(nfl.length){
      if(!out.ordem){
        var o=items.filter(function(i){return /^\d{6,}$/.test(i.s.trim())&&i.y>nfl[0].y;})[0];
        if(o)out.ordem=o.s.trim();
      }
      var nome=acha(/^NOME\/RAZ/),fant=acha(/^Nome Fantasia/),end=acha(/^ENDERE/),rep=acha(/^Representante/);
      var c={code:"",name:"",fantasia:"",address:"",obs:"",nfs:[],expected:0,items:[]};
      nfl.forEach(function(l){
        var m=/^NF\s+(\d[\d.]*)\s+(.*?)\s+Pedido\s+(\S+)/.exec(l.text)||/^NF\s+(\d[\d.]*)()/.exec(l.text);
        if(m)c.nfs.push({num:m[1].replace(/\./g,""),tipo:m[2]||""});
      });
      if(nome&&fant){
        var t=textoRegiao(items,nome.y,fant.y,440),m=/^(\d[\d.]*)\s+(.*)$/.exec(t);
        if(m){c.code=m[1];c.name=m[2];}else c.name=t;
      }
      if(fant&&end)c.fantasia=textoRegiao(items,fant.y,end.y,440);
      if(end&&rep)c.address=textoRegiao(items,end.y,rep.y,440);
      if(nome)c.obs=textoRegiao(items,nfl[nfl.length-1].y,nome.y,null);
      if(cab)c.items=produtos(cab.y);
      if(tm)c.expected=+tm[1];
      out.clientes.push(c);cur=c;
    }else if(cur){
      cur.items=cur.items.concat(produtos(cab?cab.y:1e9));
      if(tm)cur.expected=+tm[1];
    }
  });
  return out;
}
function readPdf(file){
  var status=document.getElementById("pdfStatus");
  function say(t,err){if(status){status.textContent=t;status.className="status"+(err?" err":"");}}
  if(!window.pdfjsLib){say("Não foi possível carregar o leitor de PDF. Adicione os clientes e produtos manualmente.",true);return;}
  setPdfWorker();say("Lendo o PDF...");
  var fr=new FileReader();
  fr.onerror=function(){say("Não foi possível abrir o arquivo.",true);};
  fr.onload=function(){
    pdfjsLib.getDocument({data:new Uint8Array(fr.result)}).promise.then(function(pdf){
      var pages=[];
      for(var p=1;p<=pdf.numPages;p++){
        pages.push(pdf.getPage(p).then(function(pg){return pg.getTextContent();}).then(function(c){
          return c.items.filter(function(it){return it.str&&it.str.trim();}).map(function(it){return {x:it.transform[4],y:it.transform[5],s:it.str};});
        }));
      }
      return Promise.all(pages);
    }).then(function(pages){
      var g=parseGuia(pages);
      if(!g.clientes.length){
        var vazio=!pages.some(function(p){return p.length>5;});
        say(vazio?"Este PDF parece ser uma imagem escaneada e não tem texto para ler. Adicione os clientes manualmente.":"Não reconheci este modelo de guia de entrega. Adicione os clientes manualmente.",true);
        return;
      }
      S.draft=g.clientes.map(function(c){
        return {code:c.code,name:c.name,fantasia:c.fantasia,address:c.address,obs:c.obs,nfs:nfsTexto(c.nfs),expected:c.expected,
          items:c.items.map(function(i){return {code:i.code,name:i.name,qty:i.qty,unit:""};})};
      });
      S.editC=-1;S.guiaId=uid();S.busca="";S.fil="";ensureKeys();
      if(g.ordem){S.orderName="Ordem de Carga "+g.ordem;var on=document.getElementById("orderName");if(on)on.value=S.orderName;}
      var np=S.draft.reduce(function(a,c){return a+c.items.length;},0);
      var dif=S.draft.filter(function(c){return c.expected&&c.expected!==c.items.length;}).length;
      say(S.draft.length+" cliente(s) e "+np+" produto(s) encontrados."+(dif?" "+dif+" cliente(s) com contagem diferente da informada no PDF (marcados abaixo). Confira antes de iniciar.":" A contagem de itens confere com o PDF."),dif>0);
      renderDraft();saveGuia();
    }).catch(function(){say("Não foi possível ler este PDF. Adicione os clientes manualmente.",true);});
  };
  fr.readAsArrayBuffer(file);
}

/* ---------- foto ---------- */
function compress(file,cb){
  var url=URL.createObjectURL(file);
  var img=new Image();
  img.onload=function(){
    var max=700,w=img.naturalWidth,h=img.naturalHeight,k=Math.min(1,max/Math.max(w,h));
    var c=document.createElement("canvas");c.width=Math.round(w*k);c.height=Math.round(h*k);
    c.getContext("2d").drawImage(img,0,0,c.width,c.height);
    URL.revokeObjectURL(url);
    cb(c.toDataURL("image/jpeg",0.6));
  };
  img.onerror=function(){URL.revokeObjectURL(url);cb(null);};
  img.src=url;
}

/* ---------- telas ---------- */
function render(){
  if(!unlocked){renderGate();overlays.innerHTML="";return;}
  if(S.step==="setup")renderSetup();
  else if(S.step==="check"){if(!S.openClient&&S.clients.length===1)S.openClient=S.clients[0].id;if(S.openClient)renderClient();else renderCheck();}
  else if(S.step==="report")renderReport();
  else if(S.step==="ajustes")renderSettings();
  else renderSummary();
  renderOverlays();
}

function renderSetup(){
  app.innerHTML=
    '<div class="intro"><div class="eyebrow">Doca de carregamento</div><h1 class="title">Conferência de Carga</h1>'+
    '<p>Anexe a guia de entrega em PDF. Depois escolha só o cliente que vai conferir.</p></div>'+
    '<div class="stack" style="margin-top:16px">'+
    '<button class="btn primary" data-act="pick-pdf" type="button">Anexar PDF da guia de entrega</button>'+
    '<div class="status" id="pdfStatus" role="status"></div>'+
    '<div id="guiaSel"></div>'+
    '<div class="field"><label for="conf">Conferente (quem está conferindo)</label><input class="inp" id="conf" list="confList" autocomplete="off" placeholder="Nome de quem confere" value="'+esc(S.conferente||"")+'"><datalist id="confList">'+nomes().map(function(n){return '<option value="'+esc(n)+'">';}).join("")+'</datalist></div>'+
    '<div class="field"><label for="orderName">Identificação da ordem</label><input class="inp" id="orderName" placeholder="Ex.: Ordem de Carga 1215904" value="'+esc(S.orderName)+'"></div>'+
    '</div>'+
    '<h2 class="sec-title">Clientes da ordem</h2>'+
    '<div class="actions"><div class="field"><label for="busca">Buscar cliente ou nota fiscal</label><input class="inp" id="busca" autocomplete="off" placeholder="Nome ou número da nota" value="'+esc(S.busca||"")+'"></div>'+
    '<div class="field"><label for="fil">Mostrar</label><select class="inp" id="fil"><option value="">Todos</option><option value="nao"'+(S.fil==="nao"?" selected":"")+'>Falta conferir</option><option value="falta"'+(S.fil==="falta"?" selected":"")+'>Com falta</option><option value="ok"'+(S.fil==="ok"?" selected":"")+'>Conferidos</option></select></div></div>'+
    '<div class="stack" id="draftList" style="margin-top:10px"></div>'+
    '<div class="stack" style="margin-top:12px">'+
    '<button class="btn ghost" data-act="dc-add" type="button">+ Adicionar cliente</button>'+
    (S.draft.length?'<button class="btn ghost" data-act="newguia" type="button">Fechar esta guia (fica salva)</button>':'')+
    '<button class="btn primary" data-act="report" type="button">Relatórios</button>'+
    '<button class="btn ghost" data-act="ajustes" type="button">Ajustes, senha e cópia de segurança</button></div>';
  renderDraft();renderGuiaSel();
  if(!renderSetup.loaded){renderSetup.loaded=true;loadInfo();}
}
function renderGuiaSel(){
  var b=document.getElementById("guiaSel");if(!b)return;
  if(!info.guias.length){b.innerHTML="";return;}
  b.innerHTML='<div class="field"><label for="guiaPick">Guias salvas neste computador</label><select class="inp" id="guiaPick"><option value="">Abrir uma guia salva...</option>'+
    info.guias.map(function(g){return '<option value="'+esc(g.id)+'"'+(S.guiaId===g.id?" selected":"")+'>'+esc(g.order)+' - '+esc(brDate(g.date))+' ('+g.clients.length+' clientes)</option>';}).join("")+'</select></div>';
}
function itemRowHtml(d,ci,i){
  var k=ci+"_"+i;
  return '<div class="row-edit">'+
    '<div class="field name"><label for="dn'+k+'">Produto</label><input class="inp" id="dn'+k+'" data-c="'+ci+'" data-i="'+i+'" data-f="name" value="'+esc(d.name)+'"></div>'+
    '<div class="field"><label for="dq'+k+'">Quantidade</label><input class="inp mono" id="dq'+k+'" data-c="'+ci+'" data-i="'+i+'" data-f="qty" inputmode="decimal" value="'+esc(d.qty)+'"></div>'+
    '<div class="field"><label for="du'+k+'">Unid.</label><input class="inp" id="du'+k+'" data-c="'+ci+'" data-i="'+i+'" data-f="unit" value="'+esc(d.unit||"")+'" placeholder="opcional"></div>'+
    '<button class="btn small danger del" data-act="dc-del-item" data-c="'+ci+'" data-i="'+i+'" type="button">Remover produto</button></div>';
}
function renderDraft(){
  var box=document.getElementById("draftList");if(!box)return;
  if(!S.draft.length){box.innerHTML='<div class="status">Nenhum cliente ainda. Anexe o PDF da guia, abra uma guia salva ou adicione manualmente.</div>';return;}
  ensureKeys();
  var q=nfsLimpa(S.busca||"").trim().toLowerCase(),nOk=0,nF=0,nN=0;
  var rows=S.draft.map(function(c,ci){
    var st=S.guiaId?stOf(S.guiaId,c.key):{k:"nao",label:"Falta conferir",cls:"none"};
    if(st.k==="ok")nOk++;else if(st.k==="falta")nF++;else nN++;
    return {c:c,ci:ci,st:st};
  });
  var vis=rows.filter(function(r){
    if(S.fil&&r.st.k!==S.fil)return false;
    return !q||(r.c.name+" "+r.c.fantasia+" "+r.c.nfs+" "+r.c.code).toLowerCase().indexOf(q)>=0;
  });
  box.innerHTML='<div class="hint">'+S.draft.length+' cliente(s): '+nOk+' conferido(s), '+nF+' com falta, '+nN+' falta conferir.</div>'+
    (vis.length?vis.map(function(r){
      var c=r.c,ci=r.ci,st=r.st,open=S.editC===ci,dif=c.expected&&c.expected!==c.items.length,x=st.x;
      return '<div class="dcl"><div class="dcl-h"><div style="min-width:0"><b>'+esc(c.name||"Cliente sem nome")+'</b>'+
        (c.fantasia?'<div class="hint">'+esc(c.fantasia)+'</div>':'')+
        '<div class="hint mono">NF '+esc(c.nfs||"-")+'</div>'+
        '<div class="hint">'+c.items.length+' produto(s)'+(dif?' <span class="err">· o PDF informa '+c.expected+' itens</span>':'')+'</div>'+
        (x?'<div class="hint">Conferido por '+esc(x.rec.conferente||"não informado")+' em '+esc(brDate(x.rec.date))+' '+esc(x.rec.hora)+'</div>':'')+
        '<span class="pill '+st.cls+'" style="margin-top:6px">'+esc(st.label)+'</span></div>'+
        '<div class="dcl-b"><button class="btn small primary" data-act="conf-client" data-c="'+ci+'" type="button">'+(x?"Conferir de novo":"Conferir")+'</button>'+
        '<button class="btn small ghost" data-act="dc-toggle" data-c="'+ci+'" type="button">'+(open?"Fechar":"Editar")+'</button></div></div>'+
        (open?'<div class="stack" style="margin-top:10px">'+
          '<div class="field"><label for="cn'+ci+'">Cliente</label><input class="inp" id="cn'+ci+'" data-c="'+ci+'" data-f="name" value="'+esc(c.name)+'"></div>'+
          '<div class="field"><label for="cf'+ci+'">Notas fiscais (números sem pontos)</label><input class="inp mono" id="cf'+ci+'" data-c="'+ci+'" data-f="nfs" value="'+esc(c.nfs)+'"></div>'+
          c.items.map(function(d,i){return itemRowHtml(d,ci,i);}).join("")+
          '<button class="btn ghost" data-act="dc-add-item" data-c="'+ci+'" type="button">+ Adicionar produto</button>'+
          '<button class="btn small danger" data-act="dc-del" data-c="'+ci+'" type="button">Remover cliente</button></div>':'')+'</div>';
    }).join(""):'<div class="status">Nenhum cliente encontrado.</div>');
}
function validClients(){
  return S.draft.map(function(c){
    return {code:c.code||"",name:(c.name||"").trim(),fantasia:c.fantasia||"",address:c.address||"",obs:c.obs||"",nfs:nfsLimpa(c.nfs).trim(),expected:c.expected||0,
      items:c.items.filter(function(d){return d.name.trim()&&parseNum(d.qty)>0;})};
  }).filter(function(c){return c.items.length>0;});
}
function statusOf(it){
  var l=loaded(it),f=falta(it);
  if(f===0)return {cls:"ok",card:"s-ok",label:"Completo"};
  if(l===0)return {cls:"none",card:"s-none",label:"Falta "+fmt(f)+" "+it.unit};
  return {cls:"warn",card:"s-warn",label:"Falta "+fmt(f)+" "+it.unit};
}
function clientOf(it){return S.clients.filter(function(c){return c.id===it.cid;})[0]||{name:"",nfs:""};}
function itensDe(cid){return S.items.filter(function(i){return i.cid===cid;});}
function headerHtml(sub,title,done,total){
  var pct=total?Math.round(done/total*100):0;
  return '<div class="top"><div class="row"><div style="min-width:0"><div class="eyebrow">'+sub+(S.conferente?' · '+esc(S.conferente):'')+'</div><h1 class="title">'+esc(title||S.orderName||"Conferência de Carga")+'</h1></div>'+
    '<div class="count">'+done+'/'+total+'</div></div>'+
    '<div class="bar'+(done<total?" warn":"")+'"><i style="width:'+pct+'%"></i></div></div>';
}
function clientDone(c){var its=itensDe(c.id);return its.length>0&&its.every(function(i){return falta(i)===0;});}
function clientCard(c){
  var its=itensDe(c.id),n=its.length,done=its.filter(function(i){return falta(i)===0;}).length,any=its.some(function(i){return loaded(i)>0;});
  var cls=done===n?"ok":(any?"warn":"none"),pct=n?Math.round(done/n*100):0;
  return '<button class="card s-'+cls+'" data-act="open-client" data-cid="'+c.id+'" type="button">'+
    '<div class="name">'+esc(c.name)+'</div>'+(c.fantasia?'<div class="hint">'+esc(c.fantasia)+'</div>':'')+
    '<div class="hint mono">NF '+esc(c.nfs||"-")+'</div>'+
    '<div class="nums"><div class="big">'+done+' <small>/ '+n+' produtos</small></div><span class="pill '+cls+'">'+(done===n?"Completo":(any?(n-done)+" com falta":"Não iniciado"))+'</span></div>'+
    '<div class="bar"><i style="width:'+pct+'%"></i></div></button>';
}
function clientListHtml(){
  var q=nfsLimpa(S.busca||"").trim().toLowerCase();
  var cs=S.clients.filter(function(c){return !q||(c.name+" "+c.fantasia+" "+c.nfs+" "+c.code).toLowerCase().indexOf(q)>=0;});
  return cs.length?cs.map(clientCard).join(""):'<div class="status">Nenhum cliente encontrado.</div>';
}
function productCard(it){
  var st=statusOf(it),pct=Math.min(100,Math.round(loaded(it)/it.ordered*100));
  return '<button class="card '+st.card+'" data-act="open" data-id="'+it.id+'" type="button">'+
    '<div class="name">'+esc(it.name)+'</div>'+
    '<div class="nums"><div class="big">'+fmt(loaded(it))+' <small>/ '+fmt(it.ordered)+' '+esc(it.unit)+'</small></div><span class="pill '+st.cls+'">'+st.label+'</span></div>'+
    '<div class="bar"><i style="width:'+pct+'%"></i></div></button>';
}
function renderCheck(){
  var done=S.clients.filter(clientDone).length,pend=S.clients.length-done;
  app.innerHTML=headerHtml("Conferência por cliente",S.orderName,done,S.clients.length)+
    '<div class="banner '+(pend?"warn":"ok")+'">'+(pend?("Faltam "+pend+" de "+S.clients.length+" clientes para completar a ordem."):"Carregamento completo. Todos os clientes conferem com a guia.")+'</div>'+
    '<div class="field" style="margin-top:12px"><label for="busca">Buscar cliente ou nota fiscal</label><input class="inp" id="busca" autocomplete="off" placeholder="Nome ou número da nota" value="'+esc(S.busca||"")+'"></div>'+
    '<div class="list" id="clientList">'+clientListHtml()+'</div>'+
    '<div class="stack" style="margin-top:18px">'+
    (S.confirmFinal?
      '<div class="banner '+(pend?"warn":"ok")+'" style="margin:0">'+(pend?"Ainda há cliente com falta. Salvar a carga assim mesmo?":"Salvar esta carga no relatório do dia?")+'</div>'+
      '<button class="btn primary" data-act="final-yes" type="button">Sim, salvar carga</button><button class="btn ghost" data-act="final-no" type="button">Cancelar</button>':
      '<button class="btn primary" data-act="final" type="button">Finalizar e salvar carga</button>')+'</div>'+
    '<div class="actions"><button class="btn" data-act="summary" type="button">Ver resumo</button><button class="btn" data-act="report" type="button">Relatório do dia</button></div>'+
    '<div class="stack" style="margin-top:10px">'+
    (S.confirmReset?'<button class="btn danger" data-act="reset-yes" type="button">Apagar e recomeçar</button><div class="hint">Isso apaga a conferência atual e as fotos. Toque de novo para confirmar.</div>':'<button class="btn ghost" data-act="reset" type="button">Nova ordem</button>')+'</div>';
}
function renderClient(){
  var c=S.clients.filter(function(x){return x.id===S.openClient;})[0];
  if(!c){S.openClient=null;renderCheck();return;}
  var its=itensDe(c.id),done=its.filter(function(i){return falta(i)===0;}).length,pend=its.length-done;
  app.innerHTML=headerHtml("Cliente",c.name,done,its.length)+
    '<div class="hint mono" style="margin-top:10px">NF '+esc(c.nfs||"-")+'</div>'+
    (c.fantasia?'<div class="hint">'+esc(c.fantasia)+'</div>':'')+
    (c.address?'<div class="hint">'+esc(c.address)+'</div>':'')+
    (c.obs?'<div class="hint">'+esc(c.obs)+'</div>':'')+
    '<div class="banner '+(pend?"warn":"ok")+'">'+(pend?("Faltam "+pend+" de "+its.length+" produtos deste cliente."):"Cliente completo. Todos os produtos conferem.")+'</div>'+
    '<div class="list">'+its.map(productCard).join("")+'</div>'+
    (S.clients.length>1?'<div class="stack" style="margin-top:18px"><button class="btn" data-act="back-clients" type="button">Voltar para a lista de clientes</button></div>':
    '<div class="stack" style="margin-top:18px">'+
    (S.confirmFinal?
      '<div class="banner '+(pend?"warn":"ok")+'" style="margin:0">'+(pend?"Ainda há produto com falta. Salvar esta conferência assim mesmo?":"Salvar a conferência deste cliente?")+'</div>'+
      '<button class="btn primary" data-act="final-yes" type="button">Sim, salvar conferência</button><button class="btn ghost" data-act="final-no" type="button">Cancelar</button>':
      '<button class="btn primary" data-act="final" type="button">Finalizar e salvar conferência</button>')+'</div>'+
    '<div class="actions"><button class="btn" data-act="summary" type="button">Ver resumo</button><button class="btn" data-act="report" type="button">Relatórios</button></div>'+
    '<div class="stack" style="margin-top:10px">'+
    (S.confirmReset?'<button class="btn danger" data-act="cancel-yes" type="button">Descartar esta conferência</button><div class="hint">Apaga o que foi lançado e as fotos deste cliente. Toque de novo para confirmar.</div>':'<button class="btn ghost" data-act="reset" type="button">Cancelar conferência</button>')+'</div>');
}
function summaryText(){
  var lines=["Conferência de carga - "+(S.orderName||"sem identificação")+(S.conferente?" - conferente: "+S.conferente:"")];
  S.clients.forEach(function(c){
    lines.push("","Cliente: "+c.name+(c.nfs?" - NF "+c.nfs:""));
    itensDe(c.id).forEach(function(it){
      var f=falta(it);
      lines.push((f===0?"[OK] ":"[FALTA] ")+it.name+": "+fmt(loaded(it))+" de "+fmt(it.ordered)+(it.unit?" "+it.unit:"")+(f?(" (faltam "+fmt(f)+")"):""));
    });
  });
  return lines.join("\n");
}
function renderSummary(){
  var pend=S.items.filter(function(i){return falta(i)>0;}).length,done=S.clients.filter(clientDone).length;
  app.innerHTML=headerHtml("Resumo",S.orderName,done,S.clients.length)+
    '<div class="banner '+(pend?"warn":"ok")+'">'+(pend?("Ordem incompleta: "+pend+" produto(s) com falta."):"Ordem completa.")+'</div>'+
    S.clients.map(function(c){
      return '<h2 class="sec-title" style="font-size:19px;margin-top:18px">'+esc(c.name)+'</h2><div class="hint mono">NF '+esc(c.nfs||"-")+'</div>'+
        itensDe(c.id).map(function(it){
          var st=statusOf(it);
          return '<div class="sum-row"><div class="n">'+esc(it.name)+'<div class="hint mono">'+fmt(loaded(it))+' de '+fmt(it.ordered)+' '+esc(it.unit)+'</div></div><div class="v"><span class="pill '+st.cls+'">'+st.label+'</span></div></div>';
        }).join("");
    }).join("")+
    '<div class="actions"><button class="btn" data-act="back" type="button">Voltar</button><button class="btn primary" data-act="copy" type="button">Copiar resumo</button></div>';
}

/* ---------- painel de registro ---------- */
function curItem(){return S.items.filter(function(i){return i.id===S.openId;})[0];}
function renderOverlays(){
  var html="";
  var it=curItem();
  if(it){
    var f=falta(it);
    html+='<div class="overlay" data-act="close-bg"><div class="sheet" role="dialog" aria-label="Registrar carga" id="sheetBox">'+
      '<div class="sheet-head"><h2>'+esc(it.name)+'</h2><button class="close" data-act="close" aria-label="Fechar" type="button">&times;</button></div>'+
      '<div class="hint">'+esc(clientOf(it).name)+(clientOf(it).nfs?' · NF '+esc(clientOf(it).nfs):'')+'</div>'+
      '<div class="tri"><div><span>Ordem</span><b>'+fmt(it.ordered)+'</b></div><div><span>Carregado</span><b>'+fmt(loaded(it))+'</b></div><div class="falta'+(f===0?" zero":"")+'"><span>Falta</span><b>'+fmt(f)+'</b></div></div>';
    if(f===0){
      html+='<div class="banner ok" style="margin:0 0 12px">Quantidade da ordem atingida. Não é possível adicionar mais.</div>';
    }else{
      html+='<div class="stack">'+
        '<button class="photo" data-act="take-photo" type="button" aria-label="Tirar foto">'+
          (sheet.photo?'<img alt="Foto do carregamento" src="'+sheet.photo+'">':'<span style="font-size:36px;line-height:1">&#9711;</span><span>Tirar foto da carga</span>')+'</button>'+
        '<div class="field"><label for="qtyIn">Quantidade carregada'+(it.unit?' ('+esc(it.unit)+')':'')+'</label>'+
        '<div class="qty-wrap"><input class="inp" id="qtyIn" inputmode="decimal" autocomplete="off" placeholder="0" value="'+esc(sheet.qty)+'"><span class="unit">'+esc(it.unit)+'</span></div>'+
        '<div class="hint" id="qtyHint"></div></div>'+
        '<button class="btn small" data-act="fill" type="button" style="width:100%">Completar o que falta ('+fmt(f)+' '+esc(it.unit)+')</button>'+
        '<button class="btn primary" id="saveBtn" data-act="save-entry" type="button" disabled>Registrar carga</button></div>';
    }
    if(it.entries.length){
      html+='<h3 class="sec-title" style="font-size:18px">Registros deste produto</h3><div class="entries">'+it.entries.map(function(e){
        var d=new Date(e.t);
        return '<div class="entry"><img data-act="zoom" data-e="'+e.id+'" alt="Foto registrada" src="'+e.photo+'"><div class="q"><b>'+fmt(e.qty)+' '+esc(it.unit)+'</b><span>'+d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})+'</span></div>'+
          '<button class="btn small danger" data-act="del-entry" data-e="'+e.id+'" type="button">Remover</button></div>';
      }).join("")+'</div>';
    }
    html+='</div></div>';
  }
  if(S.gallery&&S.gallery.length){
    html+='<div class="overlay" data-act="close-gallery"><div class="sheet"><div class="sheet-head"><h2>Fotos da carga</h2><button class="close" data-act="close-gallery" aria-label="Fechar" type="button">&times;</button></div>'+
      '<div class="grid-fotos">'+S.gallery.map(function(u,i){return '<img data-act="zoom-url" data-i="'+i+'" alt="Foto '+(i+1)+'" src="'+esc(u)+'">';}).join("")+'</div></div></div>';
  }
  if(S.zoom){html+='<div class="overlay lightbox" data-act="unzoom"><img alt="Foto ampliada" src="'+S.zoom+'"></div>';}
  overlays.innerHTML=html;
  if(it&&falta(it)>0)validate();
}
function validate(){
  var it=curItem();if(!it)return;
  var inp=document.getElementById("qtyIn"),hint=document.getElementById("qtyHint"),btn=document.getElementById("saveBtn");
  if(!inp)return;
  var f=falta(it),q=parseNum(inp.value),raw=inp.value.trim();
  var ok=true,msg="Máximo permitido: "+fmt(f)+" "+it.unit,cls="hint";
  if(raw===""){ok=false;}
  else if(isNaN(q)||q<=0){ok=false;msg="Digite uma quantidade maior que zero.";cls="hint err";}
  else if(r3(q)>f){ok=false;msg="Quantidade maior que a ordem. Máximo permitido: "+fmt(f)+" "+it.unit+".";cls="hint err";}
  else{
    var resta=r3(f-q);
    msg=resta===0?"Com esta quantidade a ordem deste produto fica completa.":"Depois deste registro ainda faltam "+fmt(resta)+" "+it.unit+".";
  }
  hint.textContent=msg;hint.className=cls;
  btn.disabled=!(ok&&sheet.photo);
  if(ok&&!sheet.photo)hint.textContent=msg+" Tire a foto para registrar.";
}

/* ---------- eventos ---------- */
document.addEventListener("click",function(ev){
  var el=ev.target.closest("[data-act]");if(!el)return;
  var a=el.getAttribute("data-act");
  if(a==="close-bg"){if(ev.target!==el)return;a="close";}
  if(a==="unzoom"){S.zoom=null;renderOverlays();return;}
  switch(a){
    case "pick-pdf":pdfIn.value="";pdfIn.click();break;
    case "dc-add":S.draft.push({key:uid(),code:"",name:"",fantasia:"",address:"",obs:"",nfs:"",expected:0,items:[{name:"",qty:"",unit:""}]});S.editC=S.draft.length-1;if(!S.guiaId)S.guiaId=uid();renderDraft();save();break;
    case "dc-toggle":var tc=+el.getAttribute("data-c");var wasOpen=S.editC===tc;S.editC=wasOpen?-1:tc;renderDraft();if(wasOpen)saveGuia();break;
    case "dc-add-item":S.draft[+el.getAttribute("data-c")].items.push({name:"",qty:"",unit:""});renderDraft();save();break;
    case "dc-del-item":S.draft[+el.getAttribute("data-c")].items.splice(+el.getAttribute("data-i"),1);renderDraft();save();break;
    case "dc-del":S.draft.splice(+el.getAttribute("data-c"),1);S.editC=-1;renderDraft();saveGuia();break;
    case "conf-client":
      var cc=S.draft[+el.getAttribute("data-c")];if(!cc)return;
      if(!(S.conferente||"").trim()){toast("Informe o nome do conferente antes de conferir.");var cf=document.getElementById("conf");if(cf){cf.focus();cf.scrollIntoView({block:"center"});}return;}
      var cl=cleanClient(cc);if(!cl.items.length){toast("Este cliente não tem produtos com quantidade.");return;}
      var on=document.getElementById("orderName");S.orderName=on?on.value.trim():S.orderName;
      ensureKeys();cl.key=cc.key;
      S.clients=[{id:cl.key,key:cl.key,code:cl.code,name:cl.name||"Cliente",fantasia:cl.fantasia,address:cl.address,obs:cl.obs,nfs:cl.nfs,expected:cl.expected}];
      S.items=cl.items.map(function(d){return {id:uid(),cid:cl.key,code:d.code,name:d.name,unit:d.unit,ordered:d.ordered,entries:[]};});
      lembrarNome((S.conferente||"").trim());S.orderId=uid();S.step="check";S.openClient=cl.key;S.confirmReset=false;S.confirmFinal=false;
      saveGuia();save();render();window.scrollTo(0,0);break;
    case "cancel-yes":
      S.clients=[];S.items=[];S.openClient=null;S.orderId="";S.confirmReset=false;S.confirmFinal=false;S.step="setup";save();render();window.scrollTo(0,0);break;
    case "newguia":
      S.draft=[];S.guiaId="";S.orderName="";S.editC=-1;S.busca="";S.fil="";save();render();toast("Guia fechada. Ela continua salva em 'Guias salvas'.");break;
    case "rtab":S.repTab=el.getAttribute("data-t");renderReport();break;
    case "download-sit":downloadSituacao();break;
    case "open-client":S.openClient=el.getAttribute("data-cid");render();window.scrollTo(0,0);break;
    case "back-clients":S.openClient=null;render();window.scrollTo(0,0);break;
    case "open":S.openId=el.getAttribute("data-id");sheet={photo:null,qty:""};renderOverlays();break;
    case "close":S.openId=null;sheet={photo:null,qty:""};renderOverlays();break;
    case "take-photo":photoIn.value="";photoIn.click();break;
    case "fill":
      var it=curItem();if(!it)return;
      var qi=document.getElementById("qtyIn");qi.value=String(falta(it)).replace(".",",");sheet.qty=qi.value;validate();break;
    case "save-entry":
      var cur=curItem();if(!cur)return;
      var q=parseNum(document.getElementById("qtyIn").value);
      if(!sheet.photo||isNaN(q)||q<=0||r3(q)>falta(cur)){validate();return;}
      cur.entries.push({id:uid(),qty:r3(q),photo:sheet.photo,t:Date.now()});
      S.openId=null;sheet={photo:null,qty:""};save();render();
      toast(falta(cur)===0?"Produto completo.":"Registrado. Faltam "+fmt(falta(cur))+" "+cur.unit+".");break;
    case "del-entry":
      var c2=curItem();if(!c2)return;
      var eid=el.getAttribute("data-e");
      c2.entries=c2.entries.filter(function(e){return e.id!==eid;});
      save();render();break;
    case "zoom":
      var c3=curItem();if(!c3)return;
      var en=c3.entries.filter(function(e){return e.id===el.getAttribute("data-e");})[0];
      if(en){S.zoom=en.photo;renderOverlays();}break;
    case "summary":S.step="summary";save();render();window.scrollTo(0,0);break;
    case "back":S.step="check";save();render();break;
    case "copy":
      var txt=summaryText();
      var fallback=function(){toast("Não foi possível copiar. Selecione o texto manualmente.");};
      if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(function(){toast("Resumo copiado.");},fallback);}
      else fallback();
      break;
    case "final":S.confirmFinal=true;render();break;
    case "final-no":S.confirmFinal=false;render();break;
    case "final-yes":finalize();break;
    case "report":openReport();break;
    case "rback":S.step=S.items.length?"check":"setup";save();render();window.scrollTo(0,0);break;
    case "download":downloadSheet();break;
    case "gate-enter":gateEnter();break;
    case "gate-create":gateCreate();break;
    case "change-pass":changePass();break;
    case "backup":doBackup();break;
    case "restore":document.getElementById("bkIn").click();break;
    case "sair":sair();break;
    case "ajustes":S.step="ajustes";render();window.scrollTo(0,0);break;
    case "photos":showPhotos(el.getAttribute("data-id"),el);break;
    case "zoom-url":S.zoom=S.gallery[+el.getAttribute("data-i")];renderOverlays();break;
    case "close-gallery":if(el.classList.contains("overlay")&&ev.target!==el)return;S.gallery=null;renderOverlays();break;
    case "reset":S.confirmReset=true;render();break;
    case "reset-yes":
      S={step:"setup",orderId:"",orderName:"",conferente:S.conferente,repConf:"",draft:[],items:[],clients:[],openClient:null,editC:-1,busca:"",openId:null,zoom:null,confirmReset:false,confirmFinal:false,reportDate:todayStr()};
      try{localStorage.removeItem(KEY);}catch(e){}
      render();break;
  }
});
document.addEventListener("input",function(ev){
  var t=ev.target;
  if(t.id==="qtyIn"){sheet.qty=t.value;validate();return;}
  if(t.id==="orderName"){S.orderName=t.value;save();return;}
  if(t.id==="busca"){S.busca=t.value;if(document.getElementById("draftList"))renderDraft();else{var lb=document.getElementById("clientList");if(lb)lb.innerHTML=clientListHtml();}return;}
  if(t.id==="conf"){S.conferente=t.value;save();return;}
  if(t.id==="repConf"){S.repConf=t.value;renderReport();return;}
  if(t.id==="repDate"){S.reportDate=t.value||todayStr();if(!S.reportTo||S.reportTo<S.reportDate)S.reportTo=S.reportDate;loadReport();return;}
  if(t.id==="repTo"){S.reportTo=t.value||S.reportDate;if(S.reportTo<S.reportDate)S.reportDate=S.reportTo;loadReport();return;}
  if(t.hasAttribute&&t.hasAttribute("data-f")){
    var c=S.draft[+t.getAttribute("data-c")],f=t.getAttribute("data-f");
    if(c){
      if(t.hasAttribute("data-i")){var d=c.items[+t.getAttribute("data-i")];if(d)d[f]=t.value;}
      else c[f]=t.value;
      save();
    }
  }
});
document.addEventListener("keydown",function(ev){
  if(ev.key==="Enter"&&ev.target&&(ev.target.id==="gPass"||ev.target.id==="gPass2")){if(document.getElementById("gPass2"))gateCreate();else gateEnter();}
});
document.getElementById("bkIn").addEventListener("change",function(ev){var f=ev.target.files&&ev.target.files[0];if(f)doRestore(f);ev.target.value="";});
document.addEventListener("change",function(ev){
  var t=ev.target;
  if(t.id==="fil"){S.fil=t.value;renderDraft();}
  else if(t.id==="guiaPick"&&t.value)abrirGuia(t.value);
  else if(t.id==="orderName")saveGuia();
  else if(t.id==="repGuia"){S.repGuia=t.value;renderReport();}
  else if(t.id==="repFil"){S.repFil=t.value;renderReport();}
});
pdfIn.addEventListener("change",function(){if(pdfIn.files&&pdfIn.files[0])readPdf(pdfIn.files[0]);});
photoIn.addEventListener("change",function(){
  var f=photoIn.files&&photoIn.files[0];if(!f)return;
  var qi=document.getElementById("qtyIn");if(qi)sheet.qty=qi.value;
  compress(f,function(url){
    if(!url){toast("Não foi possível ler a foto. Tente de novo.");return;}
    sheet.photo=url;renderOverlays();
  });
});

restore();
startup();
})();
