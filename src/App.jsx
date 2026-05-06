import { useState, useEffect, useRef, useCallback } from "react";
import { supabase, hasSupabaseConfig, supabaseConfigError } from "./supabaseClient";

// ══════════════════════════════════════════════
//  CONSTANTES
// ══════════════════════════════════════════════
const SERVICE_DEFAUT = {
  id: "d57fe703-bc10-482b-91b4-d532ac31bfa4",
  code: "RHUMA01",
  nom: "Service de Rhumatologie",
  etablissement: "EH Aïn El Türck - Dr. Medjber Tami",
};

const MOIS_FR  = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
const JOURS_FR = ["Dim","Lun","Mar","Mer","Jeu","Ven","Sam"];
const DEFAULT_ROTATION_ORDER = ["A","B","C","D"];

// ── GROQ (remplace Gemini) ──
const CHAT_PROVIDER       = "groq";
const CHAT_MODEL          = "llama-3.3-70b-versatile";
const CHAT_API_URL        = "https://api.groq.com/openai/v1/chat/completions";
const CHAT_SETTINGS_TABLE = "service_ai_settings";
const DEFAULT_CHAT_API_KEY = process.env.REACT_APP_GROQ_API_KEY || "";

// ── Jours fériés fixes algériens ──
const FERIES_ALGERIE = [
  { m:1,  j:1  }, { m:1,  j:12 }, { m:5,  j:1  }, { m:7,  j:5  }, { m:11, j:1  },
];

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════
const getDays  = (y,m) => new Date(y,m,0).getDate();
const getDow   = (y,m,d) => new Date(y,m-1,d).getDay();
const isWE     = d => d===5||d===6;
const pad2     = n => String(n).padStart(2,"0");
const today    = () => { const d=new Date(); return `${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()}`; };
const ck       = (gid,mi,j) => `${gid}:${mi}:${j}`;
const mnPfx    = mn => "aeiouâéèêîôûœ".includes(mn[0].toLowerCase())?"d'":"de ";
const dbError  = (error, fallback) => error?.message || error?.details || error?.hint || fallback;
const chatKeyPreview = value => value ? `${value.slice(0,7)}…${value.slice(-6)}` : "";

function extractJSON(raw) {
  try { return JSON.parse(raw.trim()); } catch {}
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) try { return JSON.parse(match[1].trim()); } catch {}
  const start = raw.indexOf("{");
  const end   = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return { action:"msg", msg: raw };
}

function mapServiceData(groupRows, memberRows) {
  const membersByGroupId = {};
  (memberRows || []).forEach(row => {
    if (!membersByGroupId[row.group_id]) membersByGroupId[row.group_id] = [];
    membersByGroupId[row.group_id].push(row);
  });
  return (groupRows || []).map(row => ({
    id: row.code,
    dbId: row.id,
    label: row.label,
    subtitle: row.subtitle,
    color: row.color,
    hasEquipe: row.has_equipe,
    membres: (membersByGroupId[row.id] || [])
      .sort((a,b)=>a.sort_order-b.sort_order)
      .map(member => ({
        id: member.id,
        nom: member.nom,
        grade: member.grade,
        equipe: row.has_equipe ? (member.equipe || DEFAULT_ROTATION_ORDER[0]) : null,
      })),
  }));
}

function shiftCongesAfterMemberDelete(prev, groupId, memberIndex) {
  const next = {};
  Object.entries(prev).forEach(([key, value]) => {
    const [gid, rawMemberIndex, rawDay] = key.split(":");
    if (gid !== groupId) { next[key] = value; return; }
    const currentMemberIndex = Number(rawMemberIndex);
    if (currentMemberIndex < memberIndex)  { next[key] = value; return; }
    if (currentMemberIndex > memberIndex)  { next[ck(gid, currentMemberIndex - 1, Number(rawDay))] = value; }
  });
  return next;
}

function isMissingRelationError(error) {
  const msg = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return error?.code === "PGRST205" || msg.includes("could not find the table") || msg.includes("does not exist");
}

async function generateWithGroq({ apiKey, systemPrompt, userPrompt }) {
  const res = await fetch(CHAT_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      max_tokens: 1500, temperature: 0.1,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Erreur Groq (${res.status})`);
  return data?.choices?.[0]?.message?.content || "";
}

function getSupabaseClient() {
  if (!supabase || !hasSupabaseConfig) throw new Error(supabaseConfigError);
  return supabase;
}

function equipeDebut(y, m, ordre) {
  return calculateNextEquipeDebut(2024, 1, ordre[0], y, m, ordre);
}

function calculateNextEquipeDebut(y1, m1, eq1, y2, m2, ordre) {
  const targetTotal = y2 * 12 + m2;
  const currentTotal = y1 * 12 + m1;
  if (targetTotal === currentTotal) return eq1;
  if (targetTotal < currentTotal) {
    const delta = (targetTotal - ((2024 * 12) + 1));
    return ordre[((delta % 4) + 4) % 4];
  }
  let curY = y1, curM = m1, curEq = eq1;
  while ((curY * 12 + curM) < targetTotal) {
    const days = getDays(curY, curM);
    const di = ordre.indexOf(curEq);
    if (di === -1) break;
    curEq = ordre[((days + di) % 4 + 4) % 4];
    curM++; if (curM > 12) { curM = 1; curY++; }
  }
  return curEq;
}

function calculateNextMemberStart(y1, m1, mi1, y2, m2, count) {
  if (!count) return 0;
  let curY = y1, curM = m1, curMi = mi1;
  while ((curY * 12 + curM) < (y2 * 12 + m2)) {
    curMi = (curMi + getDays(curY, curM)) % count;
    curM++; if (curM > 12) { curM = 1; curY++; }
  }
  return curMi;
}

async function getContinuityState(serviceId, targetYear, targetMonth, ordre, hygieneMemberCount) {
  try {
    const db = getSupabaseClient();
    const { data, error } = await db.from("rotation_state")
      .select("annee, mois, equipe_debut, ordre_equipes, hygiene_start_mi")
      .eq("service_id", serviceId)
      .or(`annee.lt.${targetYear},and(annee.eq.${targetYear},mois.lt.${targetMonth})`)
      .order("annee", { ascending: false }).order("mois", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (data) {
      const effectiveOrdre = Array.isArray(data.ordre_equipes) ? data.ordre_equipes : ordre;
      const nextEq = calculateNextEquipeDebut(data.annee, data.mois, data.equipe_debut, targetYear, targetMonth, effectiveOrdre);
      const nextHygiene = calculateNextMemberStart(data.annee, data.mois, data.hygiene_start_mi || 0, targetYear, targetMonth, hygieneMemberCount);
      return { eqDebut: nextEq, hygieneStartMi: nextHygiene };
    }
  } catch (e) { console.error("Erreur continuité:", e); }
  return { eqDebut: equipeDebut(targetYear, targetMonth, ordre), hygieneStartMi: 0 };
}

function calcMemberRotation(y, m, membres, startMi) {
  const days = getDays(y, m);
  const r = {};
  if (!membres || !membres.length) return r;
  for (let d = 1; d <= days; d++) {
    const mi = (startMi + d - 1) % membres.length;
    r[`${mi}:${d}`] = "G";
  }
  return r;
}

function calcAutoGardes(y, m, membres, ordre, forcedEqDebut = null) {
  const days = getDays(y, m);
  const debut = forcedEqDebut || equipeDebut(y, m, ordre);
  const di = ordre.indexOf(debut);
  const r = {};
  for (let d = 1; d <= days; d++) {
    const eq = ordre[((d - 1 + di) % 4 + 4) % 4];
    membres.forEach((mb, mi) => { if (mb.equipe === eq) r[`${mi}:${d}`] = "G"; });
  }
  return r;
}

// ══════════════════════════════════════════════
//  PDF — FONCTIONS COMMUNES
// ══════════════════════════════════════════════
function pdfHeader(svc, mn, year, subtitle, forLandscape = false) {
  const fs = forLandscape ? 6 : 8;
  const titleFs = forLandscape ? 8.5 : 12;
  const subFs   = forLandscape ? 7   : 9;
  return `
    <div class="ph">
      <div class="ph-rep" style="font-size:${fs}px">REPUBLIQUE ALGERIENNE DEMOCRATIQUE ET POPULAIRE</div>
      <div class="ph-min" style="font-size:${fs}px">MINISTERE DE LA SANTE, DE LA POPULATION ET DE LA REFORME HOSPITALIERE</div>
      <div class="ph-hosp" style="font-size:${fs + 1}px;font-weight:bold">${svc?.etablissement || ""}</div>
    </div>
    <div class="sigs-top">
      <span>Le Médecin Chef</span>
      <span class="unite">Unité : ${svc?.nom || ""}</span>
      <span>Le Surveillant Médical DAPM</span>
      <span>Le Directeur Général</span>
    </div>
    <div class="ptitle" style="font-size:${titleFs}px">
      TABLEAU D'ACTIVITE ${mnPfx(mn).toUpperCase()}${mn.toUpperCase()} ${year}
    </div>
    <div class="psubtitle" style="font-size:${subFs}px">${subtitle}</div>
  `;
}
function pdfFooterSigs() {
  return `<div class="footer-sigs"><span>Le Médecin Chef</span><span>Le Surveillant Médical DAPM</span><span>Le Directeur Général</span></div>`;
}
function pdfLegend() {
  return `
    <div class="leg">
      <span>G&nbsp;:&nbsp;Garde &nbsp;&nbsp; RE&nbsp;:&nbsp;Récupération &nbsp;&nbsp; C&nbsp;:&nbsp;Congé &nbsp;&nbsp; CM&nbsp;:&nbsp;Congé Maladie &nbsp;&nbsp; N&nbsp;:&nbsp;Normal</span>
      <span>Fait le&nbsp;:&nbsp;${today()}</span>
    </div>
    <div class="nb">N.B : Toutes modifications de programme ne doivent se faire qu'après accord de la direction</div>
  `;
}

// ══════════════════════════════════════════════
//  PDF 1 — LISTE DU PERSONNEL (PORTRAIT A4)
// ══════════════════════════════════════════════
function buildPdfListe(svc, groupes, year, month) {
  const mn = MOIS_FR[month - 1];
  const pages = groupes.map(gg => {
    const obs = gg.hasEquipe ? "Équipe" : "Horaire";
    const rows = gg.membres.map((m, mi) => `
      <tr class="${mi % 2 === 1 ? 'alt' : ''}">
        <td class="cn">${m.nom}</td>
        <td class="cf">${m.grade}</td>
        <td class="co">${m.equipe ? `Équipe ${m.equipe}` : (gg.subtitle.includes("12h") ? "07h-19h / 19h-07h" : "08h-16h")}</td>
      </tr>
    `).join("");
    return `
      <div class="page">
        ${pdfHeader(svc, mn, year, gg.subtitle, false)}
        <div class="tw">
          <table>
            <thead><tr><th class="hnom">Nom et Prénom</th><th class="hfn">Fonction</th><th class="hobs">${obs}</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="spacer"></div>
        ${pdfFooterSigs()}
      </div>
    `;
  }).join("");
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/>
<style>
  @page { size: A4 portrait; margin: 14mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 9px; color: #111; background: #fff; }
  .page { page-break-after: always; display: flex; flex-direction: column; min-height: 265mm; }
  .ph { text-align: center; margin-bottom: 4px; }
  .sigs-top { display: flex; justify-content: space-between; font-size: 7px; border-top: 0.5px solid #334155; border-bottom: 0.5px solid #334155; padding: 3px 0; margin-bottom: 5px; }
  .ptitle { text-align: center; font-weight: bold; font-size: 12px; margin-bottom: 3px; }
  .psubtitle { text-align: center; font-size: 9px; font-weight: bold; margin-bottom: 8px; background: #f1f5f9; padding: 3px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 0.4px solid #cbd5e1; padding: 5px 7px; }
  thead tr { background: #334155; color: white; }
  tr.alt td { background: #f8fafc; }
  .footer-sigs { display: flex; justify-content: space-around; font-size: 8px; border-top: 0.5px solid #334155; padding-top: 6px; margin-top: auto; }
</style></head><body>${pages}</body></html>`;
}

// ══════════════════════════════════════════════
//  PDF 2 — PLANNING D'ACTIVITÉ (PAYSAGE A4)
// ══════════════════════════════════════════════
function buildPdfPlanning(svc, groupes, conges, year, month, leaveTypes) {
  const mn   = MOIS_FR[month - 1];
  const days = getDays(year, month);
  const dynamicCss = leaveTypes.map(t => `.${t.code} { background:${t.color}22 !important; color:${t.color}; font-weight:700; }`).join("");
  const pages = groupes.map(gg => {
    let dayHdrs = "";
    for (let d = 1; d <= days; d++) {
      const dw = getDow(year, month, d); const we = isWE(dw);
      dayHdrs += `<th class="dh${we?" dwe":""}">${d}<br/><span>${JOURS_FR[dw]}</span></th>`;
    }
    const trows = gg.membres.map((m, mi) => {
      let cells = `<td class="cn">${m.nom}</td><td class="cg">${m.grade}</td>`;
      if (gg.hasEquipe) cells += `<td class="ce">${m.equipe || ""}</td>`;
      for (let d = 1; d <= days; d++) {
        const dw = getDow(year, month, d); const we = isWE(dw);
        const code = (conges[ck(gg.id, mi, d)] || "").toUpperCase();
        const cls  = we ? "cday cwe" : `cday${code ? ` ${code}` : ""}`;
        cells += `<td class="${cls}">${code}</td>`;
      }
      return `<tr>${cells}</tr>`;
    }).join("");
    return `
      <div class="page">
        ${pdfHeader(svc, mn, year, gg.subtitle, true)}
        <div class="tw">
          <table>
            <thead><tr><th class="hn-nom">Nom et Prénom</th><th class="hn-grd">Grade</th>${gg.hasEquipe ? '<th class="hn-eq">Eq</th>' : ""}${dayHdrs}</tr></thead>
            <tbody>${trows}</tbody>
          </table>
        </div>
        ${pdfLegend()}
      </div>
    `;
  }).join("");
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 6.5px; color: #111; background: #fff; }
  .page { page-break-after: always; display: flex; flex-direction: column; min-height: 180mm; }
  .ph { text-align: center; margin-bottom: 2px; }
  .sigs-top { display: flex; justify-content: space-between; font-size: 6px; border-top: 0.5px solid #334155; border-bottom: 0.5px solid #334155; padding: 2px 0; margin-bottom: 3px; }
  .ptitle { text-align: center; font-weight: bold; font-size: 8.5px; margin-bottom: 1px; }
  .psubtitle { text-align: center; font-size: 7px; font-weight: bold; margin-bottom: 4px; background: #f1f5f9; padding: 2px; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th, td { border: 0.25px solid #cbd5e1; text-align: center; vertical-align: middle; padding: 1px 0; }
  .hn-nom, .hn-grd, .hn-eq { background:#334155; color:#fff; font-size:6px; text-align:left; padding-left:3px; }
  .dh { background:#f1f5f9; font-weight:bold; }
  .dwe { background:#f8fafc; color:#64748b; }
  .cn { text-align:left; padding:1px 3px; font-weight:bold; }
  .cg { text-align:left; padding:1px 2px; }
  .cwe { background:#f8fafc; color:#94a3b8; }
  ${dynamicCss}
  .leg { display: flex; justify-content: space-between; font-size: 6px; margin-top: 4px; border-top: 0.3px solid #cbd5e1; padding-top: 3px; }
</style></head><body>${pages}</body></html>`;
}

// ══════════════════════════════════════════════
//  APP
// ══════════════════════════════════════════════
export default function App() {
  const [loggedIn,    setLoggedIn]    = useState(false);
  const [service,     setService]     = useState(null);
  const [inputCode,   setInputCode]   = useState("RHUMA01");
  const [inputNom,    setInputNom]    = useState("Nouveau Service");
  const [inputEtab,   setInputEtab]   = useState("Établissement");
  const [loginMsg,    setLoginMsg]    = useState("");
  const [loginBusy,   setLoginBusy]   = useState(false);
  const [loginTab,    setLoginTab]    = useState("join");

  const now = new Date();
  const [tab,      setTab]      = useState("planning");
  const [year,     setYear]     = useState(now.getFullYear());
  const [month,    setMonth]    = useState(now.getMonth()+1);
  const [groupes,  setGroupes]  = useState([]);
  const [gi,       setGi]       = useState(0);
  const [conges,   setConges]   = useState({});
  const [autoMode, setAutoMode] = useState(true);
  const [ordre,    setOrdre]    = useState(DEFAULT_ROTATION_ORDER);
  const [dragEq,   setDragEq]   = useState(null);
  const [saving,   setSaving]   = useState(false);
  const [saveMsg,  setSaveMsg]  = useState("");
  const [planStatus, setPlanStatus] = useState("loading");
  const [serviceConfigBusy, setServiceConfigBusy] = useState(false);
  const [serviceConfigMsg,  setServiceConfigMsg]  = useState("");
  const [personnelSaving,   setPersonnelSaving]   = useState(false);
  const [histo,    setHisto]    = useState([]);
  const [histoBusy,setHistoBusy]= useState(false);
  const [msgs,     setMsgs]     = useState([{r:"a",t:"Bonjour ! 🏥 Connectez-vous pour commencer."}]);
  const [chatIn,   setChatIn]   = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatApiKey,      setChatApiKey]      = useState("");
  const [chatApiKeyInput, setChatApiKeyInput] = useState("");
  const [chatApiKeyBusy,  setChatApiKeyBusy]  = useState(false);
  const [chatApiKeyMsg,   setChatApiKeyMsg]   = useState("");
  const [chatApiKeySource,setChatApiKeySource]= useState("none");
  const [showChatApiKey,  setShowChatApiKey]  = useState(false);
  const [pdfMenu,  setPdfMenu]  = useState(false);
  const [computedEqDebut, setComputedEqDebut] = useState(null);
  const [hygieneStartMi, setHygieneStartMi] = useState(0);
  const [leaveModal, setLeaveModal] = useState(null);
  const [lmType, setLmType] = useState("C");
  const [lmStart, setLmStart] = useState(1);
  const [lmEnd, setLmEnd] = useState(1);
  const [lmMode, setLmMode] = useState("range");
  const [lmDuration, setLmDuration] = useState(1);
  const chatEnd = useRef(null);

  const mn      = MOIS_FR[month-1];
  const days    = getDays(year,month);
  const g       = groupes[gi] || null;
  const eqDebut = computedEqDebut || equipeDebut(year, month, ordre);
  const effectiveChatApiKey       = chatApiKey.trim() || DEFAULT_CHAT_API_KEY.trim();
  const chatReady = Boolean(effectiveChatApiKey);
  const groupMetaById = Object.fromEntries(groupes.map(group => [group.id, { label: group.label, color: group.color }]));

  const [leaveTypes, setLeaveTypes] = useState([]);
  const [ltBusy, setLtBusy] = useState(false);
  const [ltForm, setLtForm] = useState({ code: "", label: "", color: "#3b82f6" });

  const [serviceHolidays, setServiceHolidays] = useState([]);
  const [hBusy, setHBusy] = useState(false);
  const [hLabel, setHLabel] = useState("");
  const [hMonth, setHMonth] = useState(1);
  const [hDay, setHDay] = useState(1);

  const loadLeaveTypes = useCallback(async (serviceId) => {
    if (!serviceId) return;
    setLtBusy(true);
    try {
      const db = getSupabaseClient();
      const { data, error } = await db.from("service_leave_types").select("*").eq("service_id", serviceId).order("sort_order");
      if (error) throw error;
      if (data && data.length > 0) { setLeaveTypes(data); }
      else {
        await db.rpc("seed_service_leave_types", { target_service_id: serviceId });
        const { data: seeded } = await db.from("service_leave_types").select("*").eq("service_id", serviceId).order("sort_order");
        setLeaveTypes(seeded || []);
      }
    } catch (e) {
      console.error(e);
      if (isMissingRelationError(e)) setSaveMsg("⚠️ Table 'service_leave_types' manquante.");
    } finally { setLtBusy(false); }
  }, []);

  const loadHolidays = useCallback(async (serviceId) => {
    if (!serviceId) return;
    setHBusy(true);
    try {
      const db = getSupabaseClient();
      const { data, error } = await db.from("service_holidays").select("*").eq("service_id", serviceId).order("mois, jour");
      if (error) throw error;
      setServiceHolidays(data || []);
    } catch (e) { console.error(e); } finally { setHBusy(false); }
  }, []);

  async function addLeaveType() {
    if (!ltForm.code.trim() || !ltForm.label.trim() || ltBusy) return;
    setLtBusy(true);
    try {
      const db = getSupabaseClient();
      const { data, error } = await db.from("service_leave_types").insert({
        service_id: service.id, code: ltForm.code.trim().toUpperCase(), label: ltForm.label.trim(), color: ltForm.color, sort_order: leaveTypes.length * 10 + 10
      }).select().single();
      if (error) throw error;
      setLeaveTypes(prev => [...prev, data]);
      setLtForm({ code: "", label: "", color: "#3b82f6" });
    } catch (e) { alert(isMissingRelationError(e) ? "Table manquante." : e.message); } finally { setLtBusy(false); }
  }

  async function delLeaveType(id) {
    if (ltBusy) return;
    setLtBusy(true);
    try {
      const db = getSupabaseClient();
      const { error } = await db.from("service_leave_types").delete().eq("id", id);
      if (error) throw error;
      setLeaveTypes(prev => prev.filter(t => t.id !== id));
    } catch (e) { alert(e.message); } finally { setLtBusy(false); }
  }

  useEffect(() => { if (service?.id) { loadHolidays(service.id); loadLeaveTypes(service.id); } }, [service?.id, loadHolidays, loadLeaveTypes]);

  async function addHoliday() {
    if (!hLabel.trim() || hBusy) return;
    setHBusy(true);
    try {
      const db = getSupabaseClient();
      const { data, error } = await db.from("service_holidays").insert({ service_id: service.id, mois: hMonth, jour: hDay, label: hLabel.trim() }).select().single();
      if (error) throw error;
      setServiceHolidays(prev => [...prev, data].sort((a,b) => a.mois - b.mois || a.jour - b.jour));
      setHLabel("");
    } catch (e) { alert(e.message); } finally { setHBusy(false); }
  }

  async function delHoliday(id) {
    if (hBusy) return;
    setHBusy(true);
    try {
      const db = getSupabaseClient();
      const { error } = await db.from("service_holidays").delete().eq("id", id);
      if (error) throw error;
      setServiceHolidays(prev => prev.filter(h => h.id !== id));
    } catch (e) { alert(e.message); } finally { setHBusy(false); }
  }

  const isFerie = useCallback((m, d) => {
    const fixed = FERIES_ALGERIE.some(f => f.m === m && f.j === d);
    const custom = serviceHolidays.some(h => h.mois === m && h.jour === d);
    return fixed || custom;
  }, [serviceHolidays]);

  function applyHolidaysToPlanning() {
    const nc = { ...conges };
    let count = 0;
    groupes.forEach(gg => {
      gg.membres.forEach((m, mi) => {
        for (let d = 1; d <= days; d++) {
          if (isFerie(month, d)) {
            const k = ck(gg.id, mi, d);
            if (nc[k] !== "G") { nc[k] = "F"; count++; }
          }
        }
      });
    });
    setConges(nc);
    setSaveMsg(`✅ ${count} jours fériés appliqués.`);
  }

  const loadServiceConfig = useCallback(async(serviceId, options = {})=>{
    const { seedIfEmpty = true, silent = false } = options;
    if(!serviceId){ setGroupes([]); setGi(0); return []; }
    if(!silent) setServiceConfigBusy(true);
    try {
      const db = getSupabaseClient();
      let { data: groupRows, error: groupsError } = await db.from("service_groups").select("*").eq("service_id", serviceId).order("sort_order");
      if (groupsError) throw groupsError;
      if ((groupRows || []).length === 0 && seedIfEmpty) {
        await db.rpc("seed_service_defaults", { target_service_id: serviceId });
        const { data: seeded } = await db.from("service_groups").select("*").eq("service_id", serviceId).order("sort_order");
        groupRows = seeded || [];
      }
      const groupIds = (groupRows || []).map(row => row.id);
      let memberRows = [];
      if (groupIds.length > 0) {
        const { data, error } = await db.from("service_members").select("*").in("group_id", groupIds).order("sort_order");
        if (error) throw error;
        memberRows = data || [];
      }
      const mappedGroups = mapServiceData(groupRows || [], memberRows).filter(g => g.id !== "paramedical_jour");
      setGroupes(mappedGroups);
      setGi(prev => mappedGroups.length === 0 ? 0 : Math.min(prev, mappedGroups.length - 1));
      return mappedGroups;
    } catch (error) { console.error(error); return []; } finally { setServiceConfigBusy(false); }
  },[]);

  useEffect(() => { if (service?.id) loadServiceConfig(service.id); }, [service?.id, loadServiceConfig]);

  useEffect(() => {
    let active = true;
    async function syncPlanning() {
      if (!service?.id || groupes.length === 0) return;
      setPlanStatus("loading");
      try {
        const db = getSupabaseClient();
        const { data: pRows, error: pErr } = await db.from("plannings").select("*").eq("service_id", service.id).eq("annee", year).eq("mois", month);
        if (pErr) throw pErr;
        if (pRows && pRows.length > 0) {
          const planningIds = pRows.map(r => r.id);
          const planningGroupById = Object.fromEntries(pRows.map(r => [r.id, r.groupe_id]));
          const storedOrdre = pRows.find(r => Array.isArray(r.ordre_equipes) && r.ordre_equipes.length)?.ordre_equipes;
          const { data: rotationRow } = await db.from("rotation_state").select("*").eq("service_id", service.id).eq("annee", year).eq("mois", month).maybeSingle();
          const { data: congesRows } = await db.from("conges").select("*").in("planning_id", planningIds);
          if (!active) return;
          const nc = {};
          (congesRows || []).forEach(row => { const gid = planningGroupById[row.planning_id]; if (gid) nc[ck(gid, row.membre_index, row.jour)] = row.code; });
          const effectiveOrdre = storedOrdre || rotationRow?.ordre_equipes || ordre;
          setOrdre(effectiveOrdre);
          setComputedEqDebut(rotationRow?.equipe_debut || equipeDebut(year, month, effectiveOrdre));
          setHygieneStartMi(rotationRow?.hygiene_start_mi || 0);
          setConges(nc); setPlanStatus("saved"); setSaveMsg("");
        } else {
          if (!active) return;
          const hygieneCount = groupes.find(x => x.id === "hygiene")?.membres.length || 0;
          const cont = await getContinuityState(service.id, year, month, ordre, hygieneCount);
          if (!active) return;
          setComputedEqDebut(cont.eqDebut); setHygieneStartMi(cont.hygieneStartMi);
          autoFillInternal(cont.eqDebut, cont.hygieneStartMi);
          setPlanStatus("new"); setSaveMsg("✨ Nouveau mois rempli.");
        }
      } catch (err) { console.error(err); }
    }
    syncPlanning();
    return () => { active = false; };
  }, [service?.id, year, month, groupes.length]);

  function autoFillInternal(forcedDebut, forcedHygieneStart) {
    const totalDays = getDays(year, month);
    const newConges = {};
    const effectiveDebut = forcedDebut || computedEqDebut || equipeDebut(year, month, ordre);
    const effectiveHygieneStart = (forcedHygieneStart !== undefined) ? forcedHygieneStart : hygieneStartMi;
    groupes.forEach((gg) => {
      gg.membres.forEach((m, mi) => {
        for (let d = 1; d <= totalDays; d++) {
          const dw = getDow(year, month, d), we = isWE(dw), ferie = isFerie(month, d), k = ck(gg.id, mi, d);
          if (ferie) newConges[k] = "F"; else if (we) newConges[k] = "RE"; else newConges[k] = "N";
        }
      });
    });
    groupes.forEach(gg => {
      if (gg.hasEquipe && gg.id !== "hygiene") {
        const gardes = calcAutoGardes(year, month, gg.membres, ordre, effectiveDebut);
        Object.entries(gardes).forEach(([key, code]) => { const [mi, j] = key.split(":").map(Number); newConges[ck(gg.id, mi, j)] = code; });
      }
    });
    const hygGroup = groupes.find(x => x.id === "hygiene");
    if (hygGroup) {
      const gardes = calcMemberRotation(year, month, hygGroup.membres, effectiveHygieneStart);
      Object.entries(gardes).forEach(([key, code]) => { const [mi, j] = key.split(":").map(Number); newConges[ck("hygiene", mi, j)] = code; });
    }
    setConges(newConges);
  }

  function resetWorkspace(svc) {
    if (svc) { setService(svc); setLoggedIn(true); setConges({}); setGroupes([]); setTab("planning"); }
    else { setService(null); setLoggedIn(false); setConges({}); setGroupes([]); }
  }

  function applyLeave() {
    if (!leaveModal) return;
    const { gid, mi } = leaveModal;
    const nc = { ...conges };
    const endDay = lmMode === "range" ? lmEnd : (lmStart + lmDuration - 1);
    for (let d = lmStart; d <= Math.min(endDay, days); d++) {
      const k = ck(gid, mi, d);
      if (!lmType) delete nc[k]; else nc[k] = lmType;
    }
    setConges(nc); setLeaveModal(null); setSaveMsg("⏳ Congé appliqué.");
  }

  function doLogin(svc) { resetWorkspace(svc); setLoginMsg(""); }
  async function joinService() {
    const code = inputCode.trim().toUpperCase(); if (!code) return;
    setLoginBusy(true);
    try {
      const db = getSupabaseClient();
      const { data: existing } = await db.from("services").select("*").eq("code", code).maybeSingle();
      if (existing) { doLogin(existing); return; }
      setLoginMsg("❌ Introuvable.");
    } catch (error) { setLoginMsg("❌ Erreur connexion."); } finally { setLoginBusy(false); }
  }
  async function createService() {
    const code=inputCode.trim().toUpperCase(), nom=inputNom.trim(), etab=inputEtab.trim();
    if(!code||!nom||!etab) return;
    setLoginBusy(true);
    try {
      const db = getSupabaseClient();
      const { data } = await db.from("services").upsert({ id: crypto.randomUUID(), code, nom, etablissement: etab }).select("*").single();
      doLogin(data);
    } catch (error) { setLoginMsg("❌ Création impossible."); } finally { setLoginBusy(false); }
  }

  function addM(i){ setGroupes(p=>p.map((gg,x)=>x!==i?gg:{...gg,membres:[...gg.membres,{id:crypto.randomUUID(),nom:"Nouveau",grade:"Grade",equipe:gg.hasEquipe?DEFAULT_ROTATION_ORDER[0]:null}]})); }
  function delM(i,mi){
    const groupId = groupes[i]?.id;
    setGroupes(p=>p.map((gg,x)=>x!==i?gg:{...gg,membres:gg.membres.filter((_,j)=>j!==mi)}));
    if(groupId) setConges(prev=>shiftCongesAfterMemberDelete(prev, groupId, mi));
  }
  function updM(i,mi,f,v){ setGroupes(p=>p.map((gg,x)=>x!==i?gg:{...gg,membres:gg.membres.map((m,j)=>j!==mi?m:{...m,[f]:v})})); }
  function dropEq(t){ if(!dragEq||dragEq===t)return; setOrdre(p=>{ const a=[...p],fi=a.indexOf(dragEq),ti=a.indexOf(t); a.splice(fi,1);a.splice(ti,0,dragEq);return a; }); setDragEq(null); }
  async function resetGroups() {
    if (!service?.id || !window.confirm("⚠️ Réinitialiser ?")) return;
    setServiceConfigBusy(true);
    try { await getSupabaseClient().from("service_groups").delete().eq("service_id", service.id); await loadServiceConfig(service.id); }
    finally { setServiceConfigBusy(false); }
  }
  async function savePersonnelConfig(){
    if(!service?.id) return; setPersonnelSaving(true);
    try {
      const db = getSupabaseClient(); const updatedAt = new Date().toISOString();
      const groupPayload = groupes.map((group, index) => ({ service_id: service.id, code: group.id, label: group.label, subtitle: group.subtitle, color: group.color, has_equipe: group.hasEquipe, sort_order: index, updated_at: updatedAt, id: group.dbId }));
      const { data: savedGroups } = await db.from("service_groups").upsert(groupPayload).select("*");
      const groupIdByCode = Object.fromEntries((savedGroups || []).map(row => [row.code, row.id]));
      const memberPayload = groupes.flatMap(group => {
        const groupId = groupIdByCode[group.id]; if (!groupId) return [];
        return group.membres.map((member, index) => ({ id: member.id || crypto.randomUUID(), group_id: groupId, nom: member.nom, grade: member.grade, equipe: group.hasEquipe ? (member.equipe || DEFAULT_ROTATION_ORDER[0]) : null, sort_order: index, updated_at: updatedAt }));
      });
      await db.from("service_members").upsert(memberPayload);
      await loadServiceConfig(service.id, { seedIfEmpty: false, silent: true });
      setServiceConfigMsg("✅ Personnel sauvé.");
    } catch (error) { setServiceConfigMsg("❌ Erreur."); } finally { setPersonnelSaving(false); }
  }

  async function save(congesOverride = null, silent = false){
    const effectiveConges = congesOverride ?? conges; if(!service) return;
    if(!silent) setSaving(true);
    const rows=[];
    groupes.forEach(gg=>gg.membres.forEach((m,mi)=>{ for(let j=1;j<=days;j++){ const c=effectiveConges[ck(gg.id,mi,j)]; if(c) rows.push({gid:gg.id,mi,nom:m.nom,eq:m.equipe,j,c}); } }));
    try {
      const db = getSupabaseClient(); const updatedAt = new Date().toISOString();
      const planningPayload = groupes.map(({ id: groupeId }) => ({ service_id: service.id, annee: year, mois: month, groupe_id: groupeId, ordre_equipes: ordre, updated_at: updatedAt }));
      const { data: planningRows } = await db.from("plannings").upsert(planningPayload).select("*");
      const planningIdByGroup = Object.fromEntries((planningRows || []).map(row => [row.groupe_id, row.id]));
      const planningIds = Object.values(planningIdByGroup);
      if (planningIds.length > 0) await db.from("conges").delete().in("planning_id", planningIds);
      const congesPayload = rows.map(r => { const pid = planningIdByGroup[r.gid]; return pid ? { planning_id: pid, membre_index: r.mi, membre_nom: r.nom, membre_equipe: r.eq, jour: r.j, code: r.c } : null; }).filter(Boolean);
      if (congesPayload.length > 0) await db.from("conges").insert(congesPayload);
      await db.from("rotation_state").upsert({ service_id: service.id, annee: year, mois: month, equipe_debut: eqDebut, ordre_equipes: ordre, hygiene_start_mi: hygieneStartMi });
      if(!silent) setSaveMsg("✅ Sauvegardé.");
    } catch (error) { if(!silent) setSaveMsg("❌ Erreur."); } finally { setSaving(false); }
  }

  const loadHisto=useCallback(async()=>{
    if(!service) return; setHistoBusy(true);
    try { const { data } = await getSupabaseClient().from("plannings").select("*").eq("service_id", service.id).order("annee",{ascending:false}).order("mois",{ascending:false}); setHisto(data || []); }
    finally { setHistoBusy(false); }
  },[service]);
  useEffect(()=>{ if(tab==="historique") loadHisto(); },[tab,loadHisto]);

  async function loadPlan(annee,mois){
    try {
      const db = getSupabaseClient();
      const { data: pRows } = await db.from("plannings").select("*").eq("service_id", service.id).eq("annee", annee).eq("mois", mois);
      const pIds = (pRows||[]).map(r => r.id);
      const { data: cRows } = await db.from("conges").select("*").in("planning_id", pIds);
      const groupById = Object.fromEntries(pRows.map(r => [r.id, r.groupe_id]));
      const nc={}; (cRows||[]).forEach(r=>{ const gid = groupById[r.planning_id]; if(gid) nc[ck(gid,r.membre_index,r.jour)]=r.code; });
      setConges(nc); setYear(annee); setMonth(mois); setAutoMode(false); setTab("planning");
    } catch(e) { alert("Erreur."); }
  }

  async function saveChatApiKey(){
    const nextKey = chatApiKeyInput.trim(); if(!nextKey) return;
    setChatApiKeyBusy(true);
    try{
      await getSupabaseClient().from(CHAT_SETTINGS_TABLE).upsert({ service_id: service.id, provider: CHAT_PROVIDER, api_key: nextKey });
      setChatApiKey(nextKey); setChatApiKeySource("supabase");
    } finally{ setChatApiKeyBusy(false); }
  }

  async function sendChat(){
    if(!chatReady || !chatIn.trim() || chatBusy) return;
    const txt = chatIn.trim(); setChatIn(""); setMsgs(p=>[...p,{r:"u",t:txt}]); setChatBusy(true);
    const membresList = groupes.map(gg => gg.membres.map((m, mi) => `[gid="${gg.id}" mi=${mi}] ${m.nom}`).join("\n")).join("\n");
    const systemPrompt = `Agent planning hospitalier. JSON pur uniquement. Membres:\n${membresList}`;
    try {
      const raw = await generateWithGroq({ apiKey: effectiveChatApiKey, systemPrompt, userPrompt: txt });
      const p = extractJSON(raw);
      if (p.action === "update" && Array.isArray(p.updates)) {
        const nc = { ...conges }; p.updates.forEach(u => { const k = ck(u.gid, u.mi, u.jour); if(u.code) nc[k]=u.code.toUpperCase(); else delete nc[k]; });
        setConges(nc); setMsgs(p=>[...p,{r:"a",t:"✅ Mis à jour."}]); await save(nc, true);
      } else { setMsgs(p=>[...p,{r:"a",t:p.msg || raw}]); }
    } catch(e) { setMsgs(p=>[...p,{r:"a",t:"Erreur."}]); }
    finally { setChatBusy(false); }
  }

  // ══════════════════════════════════════════════
  //  RENDER LOGIN (LIGHT THEME)
  // ══════════════════════════════════════════════
  if (!loggedIn) return (
    <div style={{minHeight:"100vh",background:"#f8fafc",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,fontFamily:"Inter,system-ui,sans-serif"}}>
      <div style={{textAlign:"center",marginBottom:32}}>
        <div style={{fontSize:64,marginBottom:16}}>🏥</div>
        <div style={{fontSize:32,fontWeight:800,color:"#1e293b",letterSpacing:"-0.02em"}}>PlanningHospital</div>
        <div style={{fontSize:14,color:"#64748b",marginTop:8}}>Gestion simplifiée du personnel hospitalier</div>
      </div>
      <div style={{width:"100%",maxWidth:400,background:"white",borderRadius:24,padding:32,boxShadow:"0 10px 25px -5px rgba(0,0,0,0.05), 0 8px 10px -6px rgba(0,0,0,0.05)",border:"1px solid #e2e8f0"}}>
        <div style={{display:"flex",background:"#f1f5f9",borderRadius:12,padding:4,marginBottom:24}}>
          {[["join","🔑 Rejoindre"],["create","✨ Créer"]].map(([id,lbl])=>(
            <button key={id} onClick={()=>setLoginTab(id)} style={{flex:1,padding:"10px",border:"none",borderRadius:8,fontSize:14,fontWeight:600,cursor:"pointer",background:loginTab===id?"white":"transparent",color:loginTab===id?"#1e293b":"#64748b",boxShadow:loginTab===id?"0 2px 4px rgba(0,0,0,0.05)":"none"}}>{lbl}</button>
          ))}
        </div>
        {loginTab==="join" ? (
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            <input value={inputCode} onChange={e=>setInputCode(e.target.value.toUpperCase())} placeholder="CODE SERVICE" style={L_FLD_BIG}/>
            <button onClick={joinService} disabled={loginBusy} style={L_BTN_PRIM}>{loginBusy?"Connexion...":"Accéder au planning"}</button>
          </div>
        ) : (
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <input value={inputCode} onChange={e=>setInputCode(e.target.value.toUpperCase())} placeholder="CODE (ex: CARDIO01)" style={L_FLD}/>
            <input value={inputNom} onChange={e=>setInputNom(e.target.value)} placeholder="Nom du service" style={L_FLD}/>
            <input value={inputEtab} onChange={e=>setInputEtab(e.target.value)} placeholder="Établissement" style={L_FLD}/>
            <button onClick={createService} disabled={loginBusy} style={L_BTN_PRIM}>Créer le service</button>
          </div>
        )}
        {loginMsg&&<div style={{marginTop:16,padding:12,borderRadius:8,background:"#fef2f2",color:"#991b1b",fontSize:13,textAlign:"center",border:"1px solid #fecaca"}}>{loginMsg}</div>}
      </div>
    </div>
  );

  // ══════════════════════════════════════════════
  //  RENDER APP (LIGHT THEME)
  // ══════════════════════════════════════════════
  const TABS=[{id:"planning",icon:"📋",lbl:"Planning"},{id:"gardes",icon:"🔄",lbl:"Rotation"},{id:"config",icon:"⚙️",lbl:"Personnel"},{id:"types_conges",icon:"🏖️",lbl:"Congés"},{id:"feries",icon:"📅",lbl:"Fériés"},{id:"historique",icon:"🕓",lbl:"Historique"},{id:"chat",icon:"💬",lbl:"IA"}];

  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",background:"#f8fafc",color:"#1e293b",fontFamily:"Inter,system-ui,sans-serif"}}>
      {/* HEADER */}
      <div style={{padding:"12px 24px",background:"white",borderBottom:"1px solid #e2e8f0",display:"flex",alignItems:"center",gap:16,boxShadow:"0 1px 3px rgba(0,0,0,0.02)"}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <span style={{fontSize:24}}>🏥</span>
          <div>
            <div style={{fontWeight:800,fontSize:15,color:"#0f172a"}}>{service.nom}</div>
            <div style={{fontSize:11,color:"#64748b"}}>{service.etablissement} • <b style={{color:"#2563eb"}}>{service.code}</b></div>
          </div>
        </div>
        <div style={{display:"flex",gap:8,marginLeft:24}}>
          <select value={month} onChange={e=>setMonth(+e.target.value)} style={L_SEL}>
            {MOIS_FR.map((m,i)=><option key={i} value={i+1}>{m}</option>)}
          </select>
          <input type="number" value={year} onChange={e=>setYear(+e.target.value)} style={{...L_INP,width:80}}/>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:8}}>
          <button onClick={()=>autoFillInternal()} style={{...L_BTN,background:"#f1f5f9",color:"#475569"}}>⚡ Auto</button>
          <button onClick={()=>save()} disabled={saving} style={L_BTN_PRIM}>{saving?"...":"💾 Sauver"}</button>
          <div style={{position:"relative"}}>
            <button onClick={()=>setPdfMenu(!pdfMenu)} style={{...L_BTN,background:"#1e293b",color:"white"}}>📄 PDF</button>
            {pdfMenu && (
              <div style={{position:"absolute",right:0,top:"110%",zIndex:100,background:"white",border:"1px solid #e2e8f0",borderRadius:12,width:200,boxShadow:"0 10px 15px -3px rgba(0,0,0,0.1)"}}>
                <button onClick={()=>{setPdfMenu(false);window.open().document.write(buildPdfListe(service,groupes,year,month));}} style={L_MENU_ITEM}>📋 Liste Personnel</button>
                <button onClick={()=>{setPdfMenu(false);window.open().document.write(buildPdfPlanning(service,groupes,conges,year,month,leaveTypes));}} style={L_MENU_ITEM}>📅 Planning</button>
              </div>
            )}
          </div>
          <button onClick={()=>resetWorkspace(null)} style={{...L_BTN,background:"#f1f5f9"}}>⬅</button>
        </div>
      </div>

      {/* TABS */}
      <div style={{display:"flex",background:"white",padding:"0 24px",borderBottom:"1px solid #e2e8f0",gap:4}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"14px 16px",border:"none",borderBottom:`2px solid ${tab===t.id?"#2563eb":"transparent"}`,background:"transparent",color:tab===t.id?"#2563eb":"#64748b",fontSize:13,fontWeight:tab===t.id?700:500,cursor:"pointer"}}>
            {t.icon} <span style={{marginLeft:6}}>{t.lbl}</span>
          </button>
        ))}
        {(tab==="planning"||tab==="config") && (
          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:4}}>
            {groupes.map((gg,x)=>(
              <button key={gg.id} onClick={()=>setGi(x)} style={{padding:"6px 12px",borderRadius:20,border:"none",background:gi===x?`${gg.color}15`:"transparent",color:gi===x?gg.color:"#64748b",fontSize:11,fontWeight:700,cursor:"pointer"}}>
                {gg.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* CONTENT */}
      <div style={{flex:1,overflow:"hidden",display:"flex"}}>
        {tab==="planning" && (
          <div style={{flex:1,padding:24,overflowY:"auto"}}>
            {g && (
              <div style={{background:"white",borderRadius:16,border:"1px solid #e2e8f0",padding:20,boxShadow:"0 1px 2px rgba(0,0,0,0.03)"}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}>
                  <b style={{fontSize:16,color:"#0f172a"}}>{g.subtitle} — {mn.toUpperCase()} {year}</b>
                  <label style={{fontSize:12,color:"#64748b",display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
                    <input type="checkbox" checked={autoMode} onChange={e=>setAutoMode(e.target.checked)}/> Gardes auto
                  </label>
                </div>
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse"}}>
                    <thead>
                      <tr>
                        <th style={L_TH_NOM}>Nom</th>
                        <th style={L_TH_GRD}>Grade</th>
                        {g.hasEquipe && <th style={L_TH_EQ}>Eq</th>}
                        {Array.from({length:days},(_,i)=>{
                          const d=i+1,dw=getDow(year,month,d),we=isWE(dw),ferie=isFerie(month,d);
                          return <th key={d} style={{...L_TH_DAY,background:ferie?"#ecfeff":we?"#fff7ed":"transparent",color:ferie?"#0891b2":we?"#c2410c":"#64748b"}}>{d}</th>;
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {g.membres.map((m,mi)=>(
                        <tr key={m.id||mi} style={{borderBottom:"1px solid #f1f5f9"}}>
                          <td style={L_TD_NOM}>{m.nom}</td>
                          <td style={L_TD_GRD}>{m.grade}</td>
                          {g.hasEquipe && <td style={L_TD_EQ}>{m.equipe}</td>}
                          {Array.from({length:days},(_,i)=>{
                            const d=i+1, code=conges[ck(g.id,mi,d)]||"", ci=leaveTypes.find(c=>c.code===code);
                            return <td key={d} onClick={()=>setLeaveModal({gid:g.id,mi,name:m.nom,day:d})} style={L_TD_DAY}>
                              <div style={{width:22,height:22,borderRadius:4,background:ci?`${ci.color}15`:"transparent",color:ci?ci.color:"#cbd5e1",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:800}}>
                                {code}
                              </div>
                            </td>;
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {tab==="config" && (
          <div style={{flex:1,padding:24,overflowY:"auto"}}>
            {g && (
              <div style={{maxWidth:900,margin:"0 auto",background:"white",borderRadius:16,border:"1px solid #e2e8f0",padding:24}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:24}}>
                  <b style={{fontSize:18}}>{g.label}</b>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={resetGroups} style={{...L_BTN,color:"#dc2626"}}>⚠️ Reset</button>
                    <button onClick={savePersonnelConfig} style={L_BTN_PRIM}>{personnelSaving?"...":"Sauvegarder"}</button>
                  </div>
                </div>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr style={{textAlign:"left",color:"#64748b",fontSize:12}}><th style={{padding:12}}>Nom</th><th style={{padding:12}}>Grade</th>{g.hasEquipe&&<th style={{padding:12}}>Eq</th>}<th></th></tr></thead>
                  <tbody>
                    {g.membres.map((m,mi)=>(
                      <tr key={m.id||mi} style={{borderTop:"1px solid #f1f5f9"}}>
                        <td style={{padding:8}}><input value={m.nom} onChange={e=>updM(gi,mi,"nom",e.target.value)} style={L_INP_TAB}/></td>
                        <td style={{padding:8}}><input value={m.grade} onChange={e=>updM(gi,mi,"grade",e.target.value)} style={L_INP_TAB}/></td>
                        {g.hasEquipe && <td style={{padding:8}}><select value={m.equipe||"A"} onChange={e=>updM(gi,mi,"equipe",e.target.value)} style={L_SEL_TAB}>{ordre.map(q=><option key={q}>{q}</option>)}</select></td>}
                        <td><button onClick={()=>delM(gi,mi)} style={{border:"none",background:"transparent",color:"#ef4444",cursor:"pointer"}}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button onClick={()=>addM(gi)} style={{marginTop:16,...L_BTN,width:"100%",border:"1px dashed #cbd5e1",color:"#64748b"}}>+ Ajouter un membre</button>
              </div>
            )}
          </div>
        )}

        {tab==="types_conges" && (
          <div style={{flex:1,padding:24,overflowY:"auto"}}>
            <div style={{maxWidth:800,margin:"0 auto"}}>
              <div style={{background:"white",borderRadius:16,border:"1px solid #e2e8f0",padding:24,marginBottom:24}}>
                <b style={{display:"block",marginBottom:16}}>Nouveau type de congé</b>
                <div style={{display:"flex",gap:12,alignItems:"flex-end"}}>
                  <div style={{flex:1}}><div style={L_LBL}>Code</div><input value={ltForm.code} onChange={e=>setLtForm({...ltForm,code:e.target.value.toUpperCase()})} style={L_INP}/></div>
                  <div style={{flex:2}}><div style={L_LBL}>Libellé</div><input value={ltForm.label} onChange={e=>setLtForm({...ltForm,label:e.target.value})} style={L_INP}/></div>
                  <div><div style={L_LBL}>Couleur</div><input type="color" value={ltForm.color} onChange={e=>setLtForm({...ltForm,color:e.target.value})} style={{...L_INP,padding:2,width:60,height:38}}/></div>
                  <button onClick={addLeaveType} style={L_BTN_PRIM}>Ajouter</button>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:16}}>
                {leaveTypes.map(t=>(
                  <div key={t.id} style={{background:"white",padding:16,borderRadius:12,border:"1px solid #e2e8f0",display:"flex",alignItems:"center",gap:12}}>
                    <div style={{width:32,height:32,borderRadius:6,background:t.color,color:"white",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800}}>{t.code}</div>
                    <div style={{flex:1,fontSize:14,fontWeight:600}}>{t.label}</div>
                    {!t.is_default && <button onClick={()=>delLeaveType(t.id)} style={{border:"none",background:"transparent",color:"#ef4444",cursor:"pointer"}}>✕</button>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Autres onglets simplifiés... */}
        {tab==="historique" && (
          <div style={{flex:1,padding:24,overflowY:"auto"}}>
            <div style={{maxWidth:600,margin:"0 auto"}}>
              <HistoList histo={histo} onLoad={loadPlan} onDelete={(a,m)=>alert("Delete")} groupMetaById={groupMetaById}/>
            </div>
          </div>
        )}

        {tab==="chat" && (
          <div style={{flex:1,display:"flex",flexDirection:"column",padding:24}}>
            <div style={{flex:1,background:"white",borderRadius:16,border:"1px solid #e2e8f0",display:"flex",flexDirection:"column",overflow:"hidden"}}>
              <div style={{flex:1,padding:20,overflowY:"auto",display:"flex",flexDirection:"column",gap:12}}>
                {msgs.map((m,i)=>(
                  <div key={i} style={{alignSelf:m.r==="u"?"flex-end":"flex-start",maxWidth:"70%",padding:"10px 16px",borderRadius:16,background:m.r==="u"?"#2563eb":"#f1f5f9",color:m.r==="u"?"white":"#1e293b",fontSize:14}}>{m.t}</div>
                ))}
                <div ref={chatEnd}/>
              </div>
              <div style={{padding:16,borderTop:"1px solid #e2e8f0",display:"flex",gap:12}}>
                <input value={chatIn} onChange={e=>setChatIn(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()} placeholder="Demander une modification..." style={{...L_INP,flex:1}}/>
                <button onClick={sendChat} style={L_BTN_PRIM}>Envoyer</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* MODAL CONGE */}
      {leaveModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.4)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
          <div style={{background:"white",borderRadius:24,width:"100%",maxWidth:400,padding:32,boxShadow:"0 25px 50px -12px rgba(0,0,0,0.25)"}}>
            <div style={{fontSize:20,fontWeight:800,marginBottom:8}}>{leaveModal.name}</div>
            <div style={{fontSize:14,color:"#64748b",marginBottom:24}}>{mn} {year}</div>

            <div style={{marginBottom:24}}>
              <div style={L_LBL}>Type d'activité</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
                {leaveTypes.map(t=>(
                  <button key={t.id} onClick={()=>setLmType(t.code)} style={{padding:10,borderRadius:10,border:`2px solid ${lmType===t.code?t.color:"#f1f5f9"}`,background:lmType===t.code?`${t.color}10`:"#f8fafc",color:lmType===t.code?t.color:"#64748b",fontWeight:700,cursor:"pointer"}}>{t.code}</button>
                ))}
                <button onClick={()=>setLmType("")} style={{padding:10,borderRadius:10,border:"2px solid #f1f5f9",background:"#f8fafc",color:"#64748b",fontWeight:700,cursor:"pointer"}}>✕</button>
              </div>
            </div>

            <div style={{display:"flex",background:"#f1f5f9",padding:4,borderRadius:12,marginBottom:20}}>
              <button onClick={()=>setLmMode("range")} style={{flex:1,padding:8,border:"none",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",background:lmMode==="range"?"white":"transparent",color:lmMode==="range"?"#1e293b":"#64748b",boxShadow:lmMode==="range"?"0 1px 2px rgba(0,0,0,0.05)":"none"}}>Dates</button>
              <button onClick={()=>setLmMode("duration")} style={{flex:1,padding:8,border:"none",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",background:lmMode==="duration"?"white":"transparent",color:lmMode==="duration"?"#1e293b":"#64748b",boxShadow:lmMode==="duration"?"0 1px 2px rgba(0,0,0,0.05)":"none"}}>Durée</button>
            </div>

            <div style={{display:"flex",gap:16,marginBottom:32}}>
              <div style={{flex:1}}><div style={L_LBL}>Début</div><input type="number" value={lmStart} onChange={e=>setLmStart(+e.target.value)} style={L_INP}/></div>
              {lmMode==="range"
                ? <div style={{flex:1}}><div style={L_LBL}>Fin</div><input type="number" value={lmEnd} onChange={e=>setLmEnd(+e.target.value)} style={L_INP}/></div>
                : <div style={{flex:1}}><div style={L_LBL}>Jours</div><input type="number" value={lmDuration} onChange={e=>setLmDuration(+e.target.value)} style={L_INP}/></div>
              }
            </div>

            <div style={{display:"flex",gap:12}}>
              <button onClick={()=>setLeaveModal(null)} style={{...L_BTN,flex:1,background:"#f1f5f9"}}>Annuler</button>
              <button onClick={applyLeave} style={{...L_BTN_PRIM,flex:1}}>Appliquer</button>
            </div>
          </div>
        </div>
      )}

      {saveMsg && <div style={{position:"fixed",bottom:24,right:24,background:"#1e293b",color:"white",padding:"12px 20px",borderRadius:12,fontSize:14,boxShadow:"0 10px 15px rgba(0,0,0,0.1)",zIndex:2000}}>{saveMsg}</div>}
    </div>
  );
}

function HistoList({ histo, onLoad, onDelete, groupMetaById }) {
  const grouped={};
  histo.forEach(r=>{ const k=`${r.annee}-${String(r.mois).padStart(2,"0")}`; if(!grouped[k])grouped[k]={annee:r.annee,mois:r.mois,rows:[]}; grouped[k].rows.push(r); });
  return <div style={{display:"flex",flexDirection:"column",gap:12}}>
    {Object.keys(grouped).sort().reverse().map(key=>{
      const {annee,mois}=grouped[key];
      return <div key={key} onClick={()=>onLoad(annee,mois)} style={{background:"white",padding:16,borderRadius:16,border:"1px solid #e2e8f0",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <b style={{fontSize:15}}>{MOIS_FR[mois-1]} {annee}</b>
        <span style={{color:"#2563eb",fontSize:13,fontWeight:700}}>Ouvrir →</span>
      </div>;
    })}
  </div>;
}

// STYLES LIGHT THEME
const L_FLD_BIG={padding:"14px 18px",borderRadius:14,border:"1px solid #e2e8f0",fontSize:18,fontWeight:700,textAlign:"center",letterSpacing:4,width:"100%",outline:"none",color:"#1e293b"};
const L_FLD={padding:"12px 14px",borderRadius:12,border:"1px solid #e2e8f0",fontSize:14,width:"100%",outline:"none"};
const L_BTN_PRIM={padding:"12px 24px",borderRadius:12,border:"none",background:"#2563eb",color:"white",fontSize:14,fontWeight:700,cursor:"pointer",boxShadow:"0 4px 6px -1px rgba(37,99,235,0.2)"};
const L_BTN={padding:"8px 16px",borderRadius:10,border:"none",fontSize:13,fontWeight:600,cursor:"pointer"};
const L_INP={padding:"10px 12px",borderRadius:10,border:"1px solid #e2e8f0",fontSize:14,outline:"none",background:"#f8fafc"};
const L_SEL={...L_INP,cursor:"pointer",paddingRight:32};
const L_MENU_ITEM={width:"100%",padding:12,textAlign:"left",border:"none",background:"transparent",fontSize:13,cursor:"pointer",borderBottom:"1px solid #f1f5f9"};
const L_LBL={fontSize:11,fontWeight:700,color:"#64748b",marginBottom:6,textTransform:"uppercase"};
const L_TH_NOM={textAlign:"left",padding:12,fontSize:11,color:"#64748b",width:140};
const L_TH_GRD={textAlign:"left",padding:12,fontSize:11,color:"#64748b",width:120};
const L_TH_EQ={padding:12,fontSize:11,color:"#64748b",width:40};
const L_TH_DAY={padding:8,fontSize:10,fontWeight:800,width:30,textAlign:"center"};
const L_TD_NOM={padding:12,fontSize:13,fontWeight:700};
const L_TD_GRD={padding:12,fontSize:12,color:"#64748b"};
const L_TD_EQ={padding:12,fontSize:13,fontWeight:800,color:"#2563eb",textAlign:"center"};
const L_TD_DAY={padding:4,textAlign:"center",cursor:"pointer"};
const L_INP_TAB={...L_INP,width:"100%",border:"none",background:"#f1f5f9"};
const L_SEL_TAB={...L_SEL,width:"100%",border:"none",background:"#f1f5f9"};
