import { useState, useEffect, useRef, useCallback } from "react";

const MCP_SERVER = {
  type: "url",
  url: "https://mcp.supabase.com/mcp?project_ref=yeswhmhlyjzjqcpawxbm",
  name: "supabase",
};

async function supabaseAI(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: `Tu es un agent Supabase. Exécute les opérations demandées via les outils MCP disponibles.
Réponds UNIQUEMENT avec du JSON valide, sans markdown, sans texte avant ou après.
Format de réponse : {"ok":true,"rows":[...]} ou {"ok":false,"error":"..."}`,
      messages: [{ role: "user", content: prompt }],
      mcp_servers: [MCP_SERVER],
    }),
  });
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || "").join("").trim();
  try { return JSON.parse(text.replace(/```json|```/g, "").trim()); }
  catch { return { ok: false, error: text }; }
}

const SERVICE_DEFAUT = {
  id: "d57fe703-bc10-482b-91b4-d532ac31bfa4",
  code: "RHUMA01",
  nom: "Service de Rhumatologie",
  etablissement: "EH Aïn El Türck - Dr. Medjber Tami",
};

const MOIS_FR  = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
const JOURS_FR = ["Dim","Lun","Mar","Mer","Jeu","Ven","Sam"];
const CODES = [
  { code:"G",  label:"Garde",         color:"#ef4444" },
  { code:"RE", label:"Récupération",  color:"#f97316" },
  { code:"C",  label:"Congé",         color:"#3b82f6" },
  { code:"CM", label:"C. Maladie",    color:"#a855f7" },
  { code:"M",  label:"Maternité",     color:"#ec4899" },
  { code:"N",  label:"Normal",        color:"#22c55e" },
  { code:"F",  label:"Férié",         color:"#06b6d4" },
];
const GROUPES_INIT = [
  { id:"medecins",       label:"👨‍⚕️ Médecins",     subtitle:"08h–16h — Personnel Médical", color:"#3b82f6", hasEquipe:false,
    membres:[{nom:"Dr. BENALI Karim",grade:"Médecin Rhumatologue",equipe:null},{nom:"Dr. MAMMERI Salima",grade:"Médecin Généraliste",equipe:null},{nom:"Dr. KACI Omar",grade:"Médecin Spécialiste",equipe:null}] },
  { id:"administratifs", label:"🗂️ Administration", subtitle:"08h–16h", color:"#8b5cf6", hasEquipe:false,
    membres:[{nom:"BOUZIANE Karima",grade:"Secrétaire Médicale",equipe:null},{nom:"MEDJDOUB Sofiane",grade:"Technicien Adm.",equipe:null},{nom:"RAIS Houria",grade:"Aide Soignante",equipe:null}] },
  { id:"paramedical",    label:"🏥 Paramédical",    subtitle:"24h", color:"#10b981", hasEquipe:true,
    membres:[{nom:"HAMDI Nadia",grade:"Infirmier Principal",equipe:"A"},{nom:"MEZIANI Youcef",grade:"Infirmier",equipe:"B"},{nom:"BRAHIMI Fatima",grade:"Infirmière",equipe:"C"},{nom:"AISSAOUI Rachid",grade:"Infirmier",equipe:"D"}] },
  { id:"hygiene",        label:"🧹 Hygiène",         subtitle:"Agents d'Hygiène — 12h", color:"#f59e0b", hasEquipe:false,
    membres:[{nom:"OULD ALI Nassima",grade:"Agent d'Hygiène",equipe:null},{nom:"FERHAT Mourad",grade:"Agent d'Hygiène",equipe:null}] },
];

const getDays = (y,m) => new Date(y,m,0).getDate();
const getDow  = (y,m,d) => new Date(y,m-1,d).getDay();
const isWE    = d => d===5||d===6;
const pad2    = n => String(n).padStart(2,"0");
const today   = () => { const d=new Date(); return `${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()}`; };
const ck      = (gid,mi,j) => `${gid}:${mi}:${j}`;
const mnPfx   = mn => "aeiouâéèêîôûœ".includes(mn[0].toLowerCase())?"d'":"de ";

function equipeDebut(y,m,ordre) {
  const delta = (((y-1)*12+m) - ((2024-1)*12+1)) % 4;
  return ordre[((delta%4)+4)%4];
}
function calcAutoGardes(y,m,membres,ordre) {
  const days=getDays(y,m), debut=equipeDebut(y,m,ordre), di=ordre.indexOf(debut), r={};
  for(let d=1;d<=days;d++){
    const eq=ordre[((d-1+di)%4+4)%4];
    membres.forEach((mb,mi)=>{ if(mb.equipe===eq) r[`${mi}:${d}`]="G"; });
  }
  return r;
}

export default function App() {
  const now = new Date();
  const [loggedIn,    setLoggedIn]    = useState(false);
  const [service,     setService]     = useState(null);
  const [inputCode,   setInputCode]   = useState("RHUMA01");
  const [inputNom,    setInputNom]    = useState("Nouveau Service");
  const [inputEtab,   setInputEtab]   = useState("Établissement");
  const [loginMsg,    setLoginMsg]    = useState("");
  const [loginBusy,   setLoginBusy]   = useState(false);
  const [loginTab,    setLoginTab]    = useState("join");
  const [tab,         setTab]         = useState("planning");
  const [year,        setYear]        = useState(now.getFullYear());
  const [month,       setMonth]       = useState(now.getMonth()+1);
  const [groupes,     setGroupes]     = useState(GROUPES_INIT);
  const [gi,          setGi]          = useState(0);
  const [conges,      setConges]      = useState({});
  const [autoMode,    setAutoMode]    = useState(true);
  const [ordre,       setOrdre]       = useState(["A","B","C","D"]);
  const [dragEq,      setDragEq]      = useState(null);
  const [saving,      setSaving]      = useState(false);
  const [saveMsg,     setSaveMsg]     = useState("");
  const [histo,       setHisto]       = useState([]);
  const [histoBusy,   setHistoBusy]   = useState(false);
  const [msgs,        setMsgs]        = useState([{r:"a",t:"Bonjour ! 🏥 Entrez votre code service pour commencer."}]);
  const [chatIn,      setChatIn]      = useState("");
  const [chatBusy,    setChatBusy]    = useState(false);
  const chatEnd = useRef(null);

  const mn      = MOIS_FR[month-1];
  const days    = getDays(year,month);
  const g       = groupes[gi];
  const eqDebut = equipeDebut(year,month,ordre);

  useEffect(()=>{
    if(!autoMode) return;
    const pi=groupes.findIndex(x=>x.id==="paramedical"); if(pi<0) return;
    const r=calcAutoGardes(year,month,groupes[pi].membres,ordre);
    setConges(prev=>{
      const n={...prev};
      Object.keys(n).filter(k=>k.startsWith("paramedical:")&&n[k]==="G").forEach(k=>delete n[k]);
      Object.entries(r).forEach(([key,code])=>{ const [mi,j]=key.split(":").map(Number); const fk=ck("paramedical",mi,j); if(!n[fk])n[fk]=code; });
      return n;
    });
  },[year,month,ordre,autoMode]);

  function doLogin(svc){ setService(svc); setLoggedIn(true); }

  function joinService(){
    const code=inputCode.trim().toUpperCase();
    if(!code){setLoginMsg("❌ Entrez un code."); return;}
    if(code==="RHUMA01"){doLogin(SERVICE_DEFAUT); return;}
    setLoginBusy(true); setLoginMsg("⏳ Recherche…");
    supabaseAI(`SELECT id,code,nom,etablissement FROM services WHERE code='${code}' LIMIT 1`)
      .then(r=>{ if(r.ok&&r.rows?.length>0)doLogin(r.rows[0]); else setLoginMsg("❌ Service introuvable."); })
      .catch(()=>setLoginMsg("❌ Erreur réseau."))
      .finally(()=>setLoginBusy(false));
  }

  function createService(){
    const code=inputCode.trim().toUpperCase(),nom=inputNom.trim(),etab=inputEtab.trim();
    if(!code||!nom||!etab){setLoginMsg("❌ Remplissez tous les champs."); return;}
    const svc={id:crypto.randomUUID(),code,nom,etablissement:etab};
    doLogin(svc);
    supabaseAI(`INSERT INTO services (id,code,nom,etablissement) VALUES ('${svc.id}','${code}','${nom}','${etab}') ON CONFLICT (code) DO NOTHING`).catch(()=>{});
  }

  function setCode(gid,mi,jour,v){ setConges(prev=>{const k=ck(gid,mi,jour),n={...prev};if(!v||v===prev[k])delete n[k];else n[k]=v.toUpperCase();return n;}); }
  function applyIA(updates){ setConges(prev=>{const n={...prev};updates.forEach(({gid,mi,jour,code})=>{const k=ck(gid,mi,jour);if(!code)delete n[k];else n[k]=code;});return n;}); }
  function addM(i){setGroupes(p=>p.map((gg,x)=>x!==i?gg:{...gg,membres:[...gg.membres,{nom:"Nouveau",grade:"Grade",equipe:gg.hasEquipe?"A":null}]}));}
  function delM(i,mi){setGroupes(p=>p.map((gg,x)=>x!==i?gg:{...gg,membres:gg.membres.filter((_,j)=>j!==mi)}));}
  function updM(i,mi,f,v){setGroupes(p=>p.map((gg,x)=>x!==i?gg:{...gg,membres:gg.membres.map((m,j)=>j!==mi?m:{...m,[f]:v})}));}
  function dropEq(t){if(!dragEq||dragEq===t)return;setOrdre(p=>{const a=[...p],fi=a.indexOf(dragEq),ti=a.indexOf(t);a.splice(fi,1);a.splice(ti,0,dragEq);return a;});setDragEq(null);}

  async function save(){
    if(!service)return;
    setSaving(true);setSaveMsg("⏳ Sauvegarde…");
    const rows=[];
    groupes.forEach(gg=>gg.membres.forEach((m,mi)=>{for(let j=1;j<=days;j++){const c=conges[ck(gg.id,mi,j)];if(c)rows.push({gid:gg.id,mi,nom:m.nom,eq:m.equipe,j,c});}}));
    const prompt=`Pour service_id='${service.id}', annee=${year}, mois=${month}: UPSERT plannings pour chaque groupe, DELETE+INSERT conges, UPSERT rotation_state equipe_debut='${eqDebut}'. Données: ${JSON.stringify(rows)}. Retourne {"ok":true}`;
    const res=await supabaseAI(prompt).catch(()=>({ok:false}));
    setSaveMsg(res.ok?`✅ ${rows.length} codes sauvegardés`:"❌ Erreur sauvegarde");
    setSaving(false);
  }

  const loadHisto=useCallback(async()=>{
    if(!service)return;setHistoBusy(true);
    const r=await supabaseAI(`SELECT * FROM plannings WHERE service_id='${service.id}' ORDER BY annee DESC,mois DESC`).catch(()=>({ok:false,rows:[]}));
    setHisto(r.rows||[]);setHistoBusy(false);
  },[service]);
  useEffect(()=>{if(tab==="historique")loadHisto();},[tab,loadHisto]);

  async function loadPlan(annee,mois){
    addA("⏳ Chargement…");
    const r=await supabaseAI(`SELECT p.groupe_id,p.ordre_equipes,c.membre_index,c.jour,c.code FROM plannings p JOIN conges c ON c.planning_id=p.id WHERE p.service_id='${service.id}' AND p.annee=${annee} AND p.mois=${mois}`).catch(()=>({ok:false,rows:[]}));
    if(!r.ok||!r.rows?.length){addA("❌ Aucune donnée.");return;}
    const nc={};
    r.rows.forEach(row=>{nc[ck(row.groupe_id,row.membre_index,row.jour)]=row.code;if(row.ordre_equipes)setOrdre(row.ordre_equipes);});
    setConges(nc);setYear(annee);setMonth(mois);setAutoMode(false);setTab("planning");
    addA(`📂 Planning ${MOIS_FR[mois-1]} ${annee} chargé.`);
  }
  async function delPlan(annee,mois){
    await supabaseAI(`DELETE FROM plannings WHERE service_id='${service.id}' AND annee=${annee} AND mois=${mois}`).catch(()=>{});
    addA("🗑️ Supprimé.");loadHisto();
  }

  function addA(t){setMsgs(p=>[...p,{r:"a",t}]);}
  async function sendChat(){
    if(!chatIn.trim()||chatBusy)return;
    const txt=chatIn.trim();setChatIn("");setMsgs(p=>[...p,{r:"u",t:txt}]);setChatBusy(true);
    const ctx={annee:year,mois:month,nomMois:mn,service:service?.nom,equipeDebut:eqDebut,ordreRotation:ordre,
      groupes:groupes.map(gg=>({id:gg.id,membres:gg.membres.map((m,mi)=>({index:mi,nom:m.nom,equipe:m.equipe,
        conges:Object.entries(conges).filter(([k])=>k.startsWith(`${gg.id}:${mi}:`)).map(([k,v])=>({jour:+k.split(":")[2],code:v})),
      }))}))};
    try{
      const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:800,
          system:`Agent planning hospitalier. CONTEXTE:${JSON.stringify(ctx)} CODES:G RE C CM M N F IDs:medecins|administratifs|paramedical|hygiene
Modification→JSON:{"action":"update","updates":[{"gid":"...","mi":0,"jour":5,"code":"C"}],"msg":"..."}
Sinon→JSON:{"action":"msg","msg":"..."}`,
          messages:[{role:"user",content:txt}]})});
      const d=await res.json();
      const raw=(d.content||[]).map(b=>b.text||"").join("");
      let p;try{p=JSON.parse(raw.replace(/```json|```/g,"").trim())}catch{p={action:"msg",msg:raw}}
      if(p.action==="update"&&p.updates){applyIA(p.updates);addA("✅ "+p.msg);}else addA(p.msg||raw);
    }catch(e){addA("⚠️ "+e.message);}
    setChatBusy(false);
    setTimeout(()=>chatEnd.current?.scrollIntoView({behavior:"smooth"}),100);
  }

  function pdf(){
    const win=window.open("","_blank");
    const MU=mn.toUpperCase(),PU=mnPfx(mn).toUpperCase();
    const pages=groupes.map(gg=>{
      let h=`<th class="hn">Nom et Prénom</th><th class="hn">Grade</th>`;
      if(gg.hasEquipe)h+=`<th class="hn">Éq.</th>`;
      for(let d=1;d<=days;d++){const dw=getDow(year,month,d);h+=`<th class="${isWE(dw)?"dw":"dh"}">${d}<br/><span>${JOURS_FR[dw].slice(0,2)}</span></th>`;}
      const rows=gg.membres.map((m,mi)=>{
        let c=`<td class="cn">${m.nom}</td><td class="cg">${m.grade}</td>`;
        if(gg.hasEquipe)c+=`<td class="ce">${m.equipe||"-"}</td>`;
        for(let d=1;d<=days;d++){const dw=getDow(year,month,d);c+=`<td class="${isWE(dw)?"cw":"cc"}">${conges[ck(gg.id,mi,d)]||""}</td>`;}
        return `<tr>${c}</tr>`;
      }).join("");
      return `<div class="page"><div class="ph"><b>RÉPUBLIQUE ALGÉRIENNE DÉMOCRATIQUE ET POPULAIRE</b><br/>MINISTÈRE DE LA SANTÉ, DE LA POPULATION ET DE LA RÉFORME HOSPITALIÈRE<br/>${service?.etablissement||""}</div>
<div class="unite">Service : ${service?.nom||""}</div>
<div class="ptitle">TABLEAU D'ACTIVITÉ ${PU}${MU} ${year} | ${gg.subtitle}</div>
<div class="tw"><table><thead><tr>${h}</tr></thead><tbody>${rows}</tbody></table></div>
<div class="leg">G:Garde RE:Récupération C:Congé CM:Congé Maladie M:Maternité N:Normal F:Férié<span>Fait le ${today()}</span></div>
<div class="nb">Rotation : ${ordre.join("→")} — Début équipe ${eqDebut}</div>
<div class="sigs"><span>Le Médecin Chef</span><span>Le Surveillant Médical</span><span>DAPM</span><span>Le Directeur Général</span></div></div>`;
    }).join("");
    win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>
@page{size:A4 landscape;margin:9mm 11mm}*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',Arial,sans-serif;font-size:7.5px}
.page{page-break-after:always;display:flex;flex-direction:column;min-height:196mm}.page:last-child{page-break-after:auto}
.ph{text-align:center;margin-bottom:5px;font-size:8px}.ph b{font-size:9px}.unite{font-size:8.5px;margin-bottom:3px}
.ptitle{text-align:center;font-weight:bold;font-size:9.5px;margin-bottom:5px}.tw{overflow:hidden;flex:1}
table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:.3px solid #888;text-align:center;vertical-align:middle;padding:1px 0}
.hn{background:#ccc;font-weight:bold;font-size:7px;width:85px}.dh{background:#ccc;font-weight:bold;font-size:6.5px;width:15px}
.dw{background:#111;color:#fff;font-weight:bold;font-size:6.5px;width:15px}.dh span,.dw span{font-size:6px;display:block}
.cn{text-align:left;padding:1px 3px;font-size:7px;font-weight:bold}.cg{text-align:left;padding:1px 2px;font-size:6.5px}
.ce{font-size:7px;width:20px}.cc{font-size:7px;height:13px;width:15px}.cw{background:#222;color:#fff;font-size:7px;height:13px;width:15px}
.leg{font-size:6.5px;margin-top:5px;display:flex;justify-content:space-between}.nb{font-size:6.5px;margin-top:2px}
.sigs{display:flex;justify-content:space-around;margin-top:28px;font-size:7px;padding-bottom:15px}
</style></head><body>${pages}</body></html>`);
    win.document.close();setTimeout(()=>win.print(),600);
  }

  const INP={background:"rgba(255,255,255,.05)",border:"1px solid rgba(255,255,255,.08)",borderRadius:6,color:"#e2e8f0",padding:"5px 9px",fontSize:12,outline:"none",fontFamily:"inherit"};
  const SEL={...INP,cursor:"pointer"};
  const BTN={padding:"6px 12px",borderRadius:6,border:"none",color:"white",fontSize:12,fontWeight:600,cursor:"pointer",background:"rgba(255,255,255,.07)",fontFamily:"inherit"};
  const TH={background:"rgba(255,255,255,.04)",color:"#475569",border:"1px solid rgba(255,255,255,.07)",padding:"6px 8px",fontWeight:600,fontSize:11,textAlign:"left"};
  const TD={padding:"5px 8px",border:"1px solid rgba(255,255,255,.04)"};
  const PTH={background:"#0c1525",color:"#475569",border:"1px solid rgba(255,255,255,.06)",textAlign:"center",fontWeight:600,fontSize:10,padding:"3px 1px"};
  const PTD={border:"1px solid rgba(255,255,255,.05)",textAlign:"center"};
  const FLD={padding:"10px 12px",borderRadius:8,border:"1px solid rgba(255,255,255,.12)",background:"rgba(255,255,255,.06)",color:"white",fontSize:13,outline:"none",fontFamily:"inherit",width:"100%"};

  if(!loggedIn) return (
    <div style={{minHeight:"100vh",background:"#050c1a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,gap:16,fontFamily:"system-ui,sans-serif"}}>
      <div style={{textAlign:"center"}}><div style={{fontSize:52}}>🏥</div><div style={{fontSize:24,fontWeight:800,color:"#f8fafc"}}>PlanningHospital</div><div style={{fontSize:12,color:"#475569",marginTop:4}}>SaaS · Multi-Service · Supabase</div></div>
      <div style={{display:"flex",gap:0,background:"rgba(255,255,255,.05)",borderRadius:10,padding:4,width:"100%",maxWidth:400}}>
        {[["join","🔑 Rejoindre"],["create","✨ Créer"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>{setLoginTab(id);setLoginMsg("");}} style={{flex:1,padding:"9px",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600,background:loginTab===id?"white":"transparent",color:loginTab===id?"#1e293b":"#64748b",boxShadow:loginTab===id?"0 1px 4px rgba(0,0,0,.2)":"none"}}>{lbl}</button>
        ))}
      </div>
      <div style={{width:"100%",maxWidth:400,background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.1)",borderRadius:14,padding:24,display:"flex",flexDirection:"column",gap:10}}>
        {loginTab==="join"?<>
          <div style={{fontSize:12,color:"#64748b"}}>Code de votre service :</div>
          <input value={inputCode} onChange={e=>setInputCode(e.target.value.toUpperCase())} onKeyDown={e=>e.key==="Enter"&&joinService()} placeholder="RHUMA01" style={{padding:"12px 14px",borderRadius:8,border:"1px solid rgba(255,255,255,.15)",background:"rgba(255,255,255,.07)",color:"white",fontSize:16,fontFamily:"monospace",letterSpacing:2,textAlign:"center",outline:"none"}}/>
          <button onClick={joinService} disabled={loginBusy} style={{padding:"13px",borderRadius:8,border:"none",cursor:"pointer",fontSize:14,fontWeight:700,background:"linear-gradient(135deg,#2563eb,#0891b2)",color:"white",opacity:loginBusy?0.7:1}}>{loginBusy?"⏳ Recherche…":"→ Entrer"}</button>
        </>:<>
          <input value={inputCode} onChange={e=>setInputCode(e.target.value.toUpperCase())} placeholder="Code (ex: CARDIO01)" style={{...FLD,textTransform:"uppercase"}}/>
          <input value={inputNom} onChange={e=>setInputNom(e.target.value)} placeholder="Nom du service" style={FLD}/>
          <input value={inputEtab} onChange={e=>setInputEtab(e.target.value)} placeholder="Établissement" style={FLD}/>
          <button onClick={createService} disabled={loginBusy} style={{padding:"13px",borderRadius:8,border:"none",cursor:"pointer",fontSize:14,fontWeight:700,background:"linear-gradient(135deg,#059669,#0891b2)",color:"white",opacity:loginBusy?0.7:1}}>{loginBusy?"⏳…":"✨ Créer ce service"}</button>
        </>}
        {loginMsg&&<div style={{padding:"8px 12px",borderRadius:8,background:"rgba(239,68,68,.1)",border:"1px solid rgba(239,68,68,.3)",color:"#fca5a5",fontSize:12,textAlign:"center"}}>{loginMsg}</div>}
      </div>
      <div style={{fontSize:11,color:"#334155"}}>💡 Démo : <span style={{color:"#60a5fa",fontFamily:"monospace",fontWeight:700}}>RHUMA01</span></div>
    </div>
  );

  const TABS=[{id:"planning",icon:"📋",lbl:"Planning"},{id:"gardes",icon:"🔄",lbl:"Rotation"},{id:"config",icon:"⚙️",lbl:"Personnel"},{id:"historique",icon:"🕓",lbl:"Historique"},{id:"chat",icon:"💬",lbl:"IA"}];

  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",background:"#070d1a",color:"#e2e8f0",fontFamily:"system-ui,sans-serif"}}>
      <div style={{padding:"10px 18px",background:"rgba(255,255,255,.03)",borderBottom:"1px solid rgba(255,255,255,.07)",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <span style={{fontSize:22}}>🏥</span>
        <div><div style={{fontWeight:700,fontSize:14,color:"#f8fafc"}}>{service.nom}</div><div style={{fontSize:10,color:"#475569"}}>{service.etablissement} · <b style={{color:"#22c55e"}}>●</b> · <b style={{color:"#60a5fa"}}>{service.code}</b></div></div>
        <select value={month} onChange={e=>setMonth(+e.target.value)} style={SEL}>{MOIS_FR.map((m,i)=><option key={i} value={i+1}>{m.charAt(0).toUpperCase()+m.slice(1)}</option>)}</select>
        <input type="number" value={year} onChange={e=>setYear(+e.target.value)} style={{...INP,width:76}}/>
        <div style={{padding:"3px 10px",borderRadius:20,background:"rgba(239,68,68,.12)",border:"1px solid #ef444430",fontSize:10,color:"#fca5a5"}}>🔄 {mn.slice(0,3)}. → Éq.<b style={{marginLeft:4}}>{eqDebut}</b></div>
        <div style={{marginLeft:"auto",display:"flex",gap:6}}>
          <button onClick={save} disabled={saving} style={{...BTN,background:"linear-gradient(135deg,#059669,#0891b2)",fontSize:11}}>{saving?"⏳…":"💾 Sauver"}</button>
          <button onClick={pdf} style={{...BTN,background:"linear-gradient(135deg,#7c3aed,#1d4ed8)",fontSize:11}}>📄 PDF</button>
          <button onClick={()=>{setLoggedIn(false);setService(null);}} style={{...BTN,background:"rgba(255,255,255,.05)",color:"#64748b",fontSize:11}}>⬅</button>
        </div>
      </div>
      {saveMsg&&<div style={{padding:"5px 18px",fontSize:11,background:saveMsg.startsWith("✅")?"rgba(34,197,94,.07)":"rgba(239,68,68,.07)",color:saveMsg.startsWith("✅")?"#4ade80":"#f87171"}}>{saveMsg}</div>}

      <div style={{display:"flex",borderBottom:"1px solid rgba(255,255,255,.07)",background:"rgba(255,255,255,.01)"}}>
        {TABS.map(t=><button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"9px 15px",border:"none",borderBottom:`2px solid ${tab===t.id?"#3b82f6":"transparent"}`,background:"transparent",color:tab===t.id?"#93c5fd":"#475569",fontSize:11,fontWeight:tab===t.id?700:400,cursor:"pointer"}}>{t.icon} {t.lbl}</button>)}
        {(tab==="planning"||tab==="config")&&<div style={{display:"flex",alignItems:"center",marginLeft:"auto",paddingRight:12,gap:2}}>
          {groupes.map((gg,x)=><button key={gg.id} onClick={()=>setGi(x)} style={{padding:"3px 9px",borderRadius:4,border:"none",background:gi===x?`${gg.color}22`:"transparent",color:gi===x?gg.color:"#475569",fontSize:10,fontWeight:gi===x?700:400,cursor:"pointer",borderBottom:gi===x?`2px solid ${gg.color}`:"2px solid transparent"}}>{gg.label}</button>)}
        </div>}
      </div>

      <div style={{flex:1,overflow:"hidden",display:"flex"}}>
        {tab==="planning"&&<div style={{flex:1,padding:16,overflowY:"auto"}}>
          <div style={{background:"rgba(255,255,255,.015)",border:`1px solid ${g.color}22`,borderRadius:10,padding:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <b style={{color:g.color,fontSize:13}}>{g.subtitle} — {mn.toUpperCase()} {year}</b>
              {g.id==="paramedical"&&<label style={{fontSize:10,color:"#64748b",display:"flex",gap:5,cursor:"pointer",alignItems:"center"}}><input type="checkbox" checked={autoMode} onChange={e=>setAutoMode(e.target.checked)} style={{accentColor:"#ef4444"}}/>Gardes auto</label>}
            </div>
            <div style={{overflowX:"auto"}}>
              <table style={{borderCollapse:"collapse",fontSize:10,tableLayout:"fixed"}}>
                <thead><tr>
                  <th style={{...PTH,width:120,textAlign:"left",padding:"3px 6px"}}>Nom</th>
                  <th style={{...PTH,width:84,textAlign:"left",padding:"3px 3px"}}>Grade</th>
                  {g.hasEquipe&&<th style={{...PTH,width:22,color:g.color}}>Éq</th>}
                  {Array.from({length:days},(_,i)=>{const d=i+1,dw=getDow(year,month,d),we=isWE(dw);return <th key={d} style={{...PTH,width:21,padding:"2px 0",background:we?"#1a0800":"#0c1625",color:we?"#f97316":"#475569",fontSize:8}}>{d}<br/><span style={{fontSize:7}}>{JOURS_FR[dw].slice(0,2)}</span></th>;})}
                </tr></thead>
                <tbody>{g.membres.map((m,mi)=><tr key={mi} style={{borderBottom:"1px solid rgba(255,255,255,.03)"}}>
                  <td style={{...PTD,padding:"2px 6px",fontWeight:600,color:"#e2e8f0"}}>{m.nom}</td>
                  <td style={{...PTD,padding:"2px 3px",color:"#64748b",fontSize:9}}>{m.grade}</td>
                  {g.hasEquipe&&<td style={{...PTD,textAlign:"center",color:g.color,fontWeight:700,fontSize:10}}>{m.equipe}</td>}
                  {Array.from({length:days},(_,i)=>{const d=i+1,dw=getDow(year,month,d),we=isWE(dw),code=conges[ck(g.id,mi,d)]||"",ci=CODES.find(c=>c.code===code),isAuto=autoMode&&g.id==="paramedical"&&code==="G";
                    return <td key={d} style={{...PTD,width:21,padding:0,background:we?"rgba(40,12,0,.5)":isAuto?"rgba(239,68,68,.05)":"transparent"}}>
                      <input value={code} maxLength={3} onChange={e=>setCode(g.id,mi,d,e.target.value)} style={{width:21,height:20,border:"none",background:"transparent",textAlign:"center",fontSize:9,fontWeight:700,outline:"none",color:ci?ci.color:we?"#2d1a0a":"#334155",fontStyle:isAuto?"italic":"normal",cursor:"text"}}/>
                    </td>;})}
                </tr>)}</tbody>
              </table>
            </div>
            <div style={{marginTop:8,display:"flex",gap:8,flexWrap:"wrap",fontSize:9}}>{CODES.map(c=><span key={c.code}><b style={{color:c.color}}>{c.code}</b><span style={{color:"#475569"}}> {c.label}</span></span>)}</div>
          </div>
        </div>}

        {tab==="gardes"&&<div style={{flex:1,padding:20,overflowY:"auto"}}>
          <div style={{background:"rgba(239,68,68,.06)",border:"1px solid rgba(239,68,68,.2)",borderRadius:10,padding:14,marginBottom:14,fontSize:12,color:"#94a3b8",lineHeight:1.8}}>
            🔄 Ce mois de <b style={{color:"#f8fafc"}}>{mn} {year}</b>, équipe <b style={{color:"#ef4444",fontSize:16}}>{eqDebut}</b> commence le 1er. Glissez pour modifier l'ordre.
          </div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:20}}>
            {ordre.map((eq,i)=><div key={eq} draggable onDragStart={()=>setDragEq(eq)} onDragOver={e=>e.preventDefault()} onDrop={()=>dropEq(eq)} style={{display:"flex",alignItems:"center",gap:10,padding:"12px 20px",borderRadius:10,cursor:"grab",userSelect:"none",background:eq===eqDebut?"rgba(239,68,68,.18)":"rgba(255,255,255,.05)",border:`2px solid ${eq===eqDebut?"#ef4444":"rgba(255,255,255,.12)"}`,boxShadow:dragEq===eq?"0 0 0 3px #ef444444":"none"}}>
              <span style={{fontSize:11,color:"#475569"}}>#{i+1}</span>
              <span style={{fontSize:22,fontWeight:800,color:eq===eqDebut?"#ef4444":"#e2e8f0"}}>Équipe {eq}</span>
              {eq===eqDebut&&<span style={{fontSize:9,color:"#ef4444",background:"rgba(239,68,68,.15)",padding:"2px 7px",borderRadius:8}}>ce mois</span>}
              <span style={{color:"#334155",fontSize:16}}>⠿</span>
            </div>)}
          </div>
          <button onClick={()=>setOrdre(["A","B","C","D"])} style={{...BTN,background:"rgba(255,255,255,.05)",color:"#64748b",marginBottom:20}}>↺ Reset A→B→C→D</button>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:8}}>
            {Array.from({length:12},(_,i)=>{const m2=(month+i-1)%12+1,y2=year+Math.floor((month+i-1)/12),eq=equipeDebut(y2,m2,ordre),cur=m2===month&&y2===year;
              return <div key={i} style={{background:cur?"rgba(239,68,68,.09)":"rgba(255,255,255,.02)",border:`1px solid ${cur?"rgba(239,68,68,.3)":"rgba(255,255,255,.06)"}`,borderRadius:8,padding:"9px 12px"}}>
                <div style={{fontSize:11,color:cur?"#fca5a5":"#64748b",fontWeight:cur?700:400}}>{MOIS_FR[m2-1].slice(0,4)}. {y2}</div>
                <div style={{marginTop:4,display:"flex",gap:3}}>{ordre.map(e=><span key={e} style={{fontSize:10,padding:"1px 5px",borderRadius:3,background:e===eq?"rgba(239,68,68,.2)":"rgba(255,255,255,.03)",color:e===eq?"#ef4444":"#475569",fontWeight:e===eq?700:400}}>{e}{e===eq?"🚦":""}</span>)}</div>
              </div>;})}
          </div>
        </div>}

        {tab==="config"&&<div style={{flex:1,padding:18,overflowY:"auto"}}>
          <div style={{background:"rgba(255,255,255,.02)",border:`1px solid ${g.color}20`,borderRadius:9,padding:16}}>
            <div style={{fontSize:12,fontWeight:700,color:g.color,marginBottom:12}}>{g.label}</div>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr style={{background:"rgba(255,255,255,.04)"}}><th style={TH}>N°</th><th style={TH}>Nom</th><th style={TH}>Grade</th>{g.hasEquipe&&<th style={{...TH,width:65}}>Éq.</th>}<th style={{...TH,width:36}}></th></tr></thead>
              <tbody>{g.membres.map((m,mi)=><tr key={mi} style={{borderBottom:"1px solid rgba(255,255,255,.04)"}}>
                <td style={{...TD,color:"#475569",textAlign:"center",width:32}}>{mi+1}</td>
                <td style={TD}><input value={m.nom} onChange={e=>updM(gi,mi,"nom",e.target.value)} style={{...INP,width:"100%"}}/></td>
                <td style={TD}><input value={m.grade} onChange={e=>updM(gi,mi,"grade",e.target.value)} style={{...INP,width:"100%"}}/></td>
                {g.hasEquipe&&<td style={TD}><select value={m.equipe||"A"} onChange={e=>updM(gi,mi,"equipe",e.target.value)} style={{...SEL,width:54}}>{ordre.map(q=><option key={q}>{q}</option>)}</select></td>}
                <td style={{...TD,textAlign:"center"}}><button onClick={()=>delM(gi,mi)} style={{background:"rgba(239,68,68,.12)",border:"none",color:"#f87171",borderRadius:4,padding:"2px 6px",cursor:"pointer"}}>✕</button></td>
              </tr>)}</tbody>
            </table>
            <button onClick={()=>addM(gi)} style={{marginTop:10,...BTN,background:"transparent",border:`1px dashed ${g.color}44`,color:g.color,fontSize:11}}>+ Ajouter</button>
          </div>
        </div>}

        {tab==="historique"&&<div style={{flex:1,padding:18,overflowY:"auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <b style={{fontSize:13,color:"#93c5fd"}}>🕓 Historique</b>
            <button onClick={loadHisto} disabled={histoBusy} style={{...BTN,fontSize:11}}>{histoBusy?"⏳":"🔄"}</button>
          </div>
          {histoBusy?<div style={{color:"#475569",textAlign:"center",padding:20}}>⏳ Chargement…</div>
          :histo.length===0?<div style={{color:"#475569",textAlign:"center",padding:32}}>Aucun planning sauvegardé.</div>
          :<div style={{display:"flex",flexDirection:"column",gap:8}}>
            {Object.entries(histo.reduce((acc,r)=>{const k=`${r.annee}-${String(r.mois).padStart(2,"0")}`;if(!acc[k])acc[k]={annee:r.annee,mois:r.mois,rows:[]};acc[k].rows.push(r);return acc;},{})).sort().reverse().map(([key,{annee,mois,rows}])=>
              <div key={key} style={{background:"rgba(255,255,255,.02)",border:"1px solid rgba(255,255,255,.07)",borderRadius:9,padding:"12px 15px"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <b style={{fontSize:13,color:"#93c5fd"}}>📅 {MOIS_FR[mois-1].charAt(0).toUpperCase()+MOIS_FR[mois-1].slice(1)} {annee}</b>
                  <div style={{flex:1,display:"flex",gap:4,flexWrap:"wrap"}}>
                    {rows.map(r=>{const gg=GROUPES_INIT.find(g=>g.id===r.groupe_id);return <span key={r.id} style={{fontSize:9,padding:"1px 6px",borderRadius:3,background:`${gg?.color||"#64748b"}15`,color:gg?.color||"#64748b"}}>{gg?.label||r.groupe_id}</span>;})}
                  </div>
                  <button onClick={()=>loadPlan(annee,mois)} style={{...BTN,fontSize:10,padding:"3px 10px",background:"rgba(59,130,246,.15)",color:"#93c5fd"}}>📂</button>
                  <button onClick={()=>delPlan(annee,mois)} style={{...BTN,fontSize:10,padding:"3px 9px",background:"rgba(239,68,68,.1)",color:"#f87171"}}>🗑️</button>
                </div>
              </div>
            )}
          </div>}
        </div>}

        {tab==="chat"&&<div style={{flex:1,display:"flex",flexDirection:"column",padding:16}}>
          <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:10,paddingBottom:10}}>
            {msgs.map((m,i)=><div key={i} style={{display:"flex",justifyContent:m.r==="u"?"flex-end":"flex-start"}}>
              <div style={{maxWidth:"80%",background:m.r==="u"?"linear-gradient(135deg,#1d4ed8,#0891b2)":"rgba(255,255,255,.04)",border:m.r==="a"?"1px solid rgba(255,255,255,.07)":"none",borderRadius:m.r==="u"?"12px 12px 2px 12px":"12px 12px 12px 2px",padding:"9px 13px",fontSize:12,lineHeight:1.7,color:m.r==="u"?"white":"#e2e8f0",whiteSpace:"pre-wrap"}}>
                {m.r==="a"&&<span style={{marginRight:5}}>🏥</span>}{m.t}
              </div>
            </div>)}
            {chatBusy&&<div style={{color:"#475569",fontSize:11,display:"flex",gap:6}}><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>⟳</span>Analyse…</div>}
            <div ref={chatEnd}/>
          </div>
          <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:7}}>
            {["BOUZIANE en congé du 5 au 12","HAMDI en récup le 20","Qui est en garde le 15 ?"].map(s=><button key={s} onClick={()=>setChatIn(s)} style={{padding:"3px 8px",borderRadius:5,border:"1px solid rgba(59,130,246,.25)",background:"rgba(59,130,246,.07)",color:"#60a5fa",fontSize:10,cursor:"pointer"}}>{s}</button>)}
          </div>
          <div style={{display:"flex",gap:7,background:"rgba(255,255,255,.02)",border:"1px solid rgba(255,255,255,.07)",borderRadius:8,padding:"7px 10px"}}>
            <input value={chatIn} onChange={e=>setChatIn(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()} placeholder="Parlez à l'agent…" style={{flex:1,background:"transparent",border:"none",color:"#e2e8f0",fontSize:12,outline:"none"}}/>
            <button onClick={sendChat} disabled={chatBusy||!chatIn.trim()} style={{...BTN,fontSize:11,background:chatBusy||!chatIn.trim()?"rgba(255,255,255,.04)":"linear-gradient(135deg,#1d4ed8,#0891b2)",color:chatBusy||!chatIn.trim()?"#475569":"white"}}>{chatBusy?"…":"↵"}</button>
          </div>
        </div>}
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-thumb{background:#1e293b;border-radius:2px}select option{background:#0d1526}`}</style>
    </div>
  );
}
