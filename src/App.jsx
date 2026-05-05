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
const CODES = [
  { code:"G",  label:"Garde",         color:"#ef4444" },
  { code:"RE", label:"Récupération",  color:"#f97316" },
  { code:"C",  label:"Congé",         color:"#3b82f6" },
  { code:"CM", label:"C. Maladie",    color:"#a855f7" },
  { code:"M",  label:"Maternité",     color:"#ec4899" },
  { code:"N",  label:"Normal",        color:"#22c55e" },
  { code:"F",  label:"Férié",         color:"#06b6d4" },
];
const DEFAULT_ROTATION_ORDER = ["A","B","C","D"];

// ── GROQ (remplace Gemini) ──
const CHAT_PROVIDER       = "groq";
const CHAT_MODEL          = "llama-3.3-70b-versatile";   // gratuit · 14 400 req/jour
const CHAT_API_URL        = "https://api.groq.com/openai/v1/chat/completions";
const CHAT_SETTINGS_TABLE = "service_ai_settings";
const DEFAULT_CHAT_API_KEY = process.env.REACT_APP_GROQ_API_KEY || "";

// ── Jours fériés fixes algériens ──
const FERIES_ALGERIE = [
  { m:1,  j:1  }, // Nouvel An
  { m:1,  j:12 }, // Yennayer (Nouvel An amazigh)
  { m:5,  j:1  }, // Fête du Travail
  { m:7,  j:5  }, // Fête de l'Indépendance
  { m:11, j:1  }, // Fête de la Révolution
];

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════
const getDays  = (y,m) => new Date(y,m,0).getDate();
const getDow   = (y,m,d) => new Date(y,m-1,d).getDay();
const isWE     = d => d===5||d===6;   // vendredi=5, samedi=6 (Algérie)
const pad2     = n => String(n).padStart(2,"0");
const today    = () => { const d=new Date(); return `${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()}`; };
const ck       = (gid,mi,j) => `${gid}:${mi}:${j}`;
const mnPfx    = mn => "aeiouâéèêîôûœ".includes(mn[0].toLowerCase())?"d'":"de ";
const dbError  = (error, fallback) => error?.message || error?.details || error?.hint || fallback;
const chatKeyPreview = value => value ? `${value.slice(0,7)}…${value.slice(-6)}` : "";
const isFerieAlg = (month, day) => FERIES_ALGERIE.some(f => f.m === month && f.j === day);

// ── Extracteur JSON robuste (gère markdown + texte parasite) ──
function extractJSON(raw) {
  // 1. Tentative directe
  try { return JSON.parse(raw.trim()); } catch {}
  // 2. Extrait depuis bloc ```json ... ```
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) try { return JSON.parse(match[1].trim()); } catch {}
  // 3. Extrait le premier { ... } valide
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

// ── Groq (API OpenAI-compatible) ──
async function generateWithGroq({ apiKey, systemPrompt, userPrompt }) {
  const res = await fetch(CHAT_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
      max_tokens: 1500,
      temperature: 0.1,
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
  // Epoch: Janvier 2024 commence avec l'équipe à l'index 0 (souvent 'A')
  // On utilise le calcul de continuité depuis cette époque pour un réalisme accru
  return calculateNextEquipeDebut(2024, 1, ordre[0], y, m, ordre);
}

/**
 * Calcule l'équipe qui commence un mois donné en fonction de l'équipe de début d'un mois précédent.
 */
function calculateNextEquipeDebut(y1, m1, eq1, y2, m2, ordre) {
  const targetTotal = y2 * 12 + m2;
  const currentTotal = y1 * 12 + m1;
  
  if (targetTotal === currentTotal) return eq1;
  
  // Si on cherche dans le passé, on utilise la formule fixe par simplicité
  if (targetTotal < currentTotal) {
    const delta = (targetTotal - ((2024 * 12) + 1));
    return ordre[((delta % 4) + 4) % 4];
  }

  let curY = y1, curM = m1, curEq = eq1;
  while ((curY * 12 + curM) < targetTotal) {
    const days = getDays(curY, curM);
    const di = ordre.indexOf(curEq);
    if (di === -1) break; // Sécurité
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
      .order("annee", { ascending: false })
      .order("mois", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (data) {
      const effectiveOrdre = Array.isArray(data.ordre_equipes) ? data.ordre_equipes : ordre;
      const nextEq = calculateNextEquipeDebut(data.annee, data.mois, data.equipe_debut, targetYear, targetMonth, effectiveOrdre);
      const nextHygiene = calculateNextMemberStart(data.annee, data.mois, data.hygiene_start_mi || 0, targetYear, targetMonth, hygieneMemberCount);
      return { eqDebut: nextEq, hygieneStartMi: nextHygiene };
    }
  } catch (e) { console.error("Erreur continuité:", e); }
  return {
    eqDebut: equipeDebut(targetYear, targetMonth, ordre),
    hygieneStartMi: 0 // Fallback
  };
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
const ACT_CSS = `
  .G  { background:#FFCDD2 !important; color:#B71C1C; font-weight:700; }
  .RE { background:#FFF9C4 !important; color:#7B6000; font-weight:700; }
  .C  { background:#C8E6C9 !important; color:#1B5E20; font-weight:700; }
  .CM { background:#F8BBD0 !important; color:#880E4F; font-weight:700; }
  .M  { background:#FCE4EC !important; color:#880E4F; font-weight:700; }
  .F  { background:#E0F7FA !important; color:#006064; font-weight:700; }
`;

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
  @page { size: A4 portrait; margin: 14mm 14mm 12mm 14mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 9px; color: #111; }
  .page { page-break-after: always; display: flex; flex-direction: column; min-height: 265mm; }
  .page:last-child { page-break-after: auto; }
  .ph { text-align: center; margin-bottom: 4px; }
  .ph-rep { font-size: 7.5px; color: #222; }
  .ph-min { font-size: 7.5px; color: #222; margin-top: 1px; }
  .ph-hosp { font-size: 9px; font-weight: bold; color: #1B3A6B; margin-top: 3px; }
  .sigs-top { display: flex; justify-content: space-between; align-items: center; font-size: 7px; color: #444; border-top: 0.5px solid #1B3A6B; border-bottom: 0.5px solid #1B3A6B; padding: 3px 0; margin-bottom: 5px; }
  .unite { font-weight: bold; font-size: 8px; color: #1B3A6B; }
  .ptitle { text-align: center; font-weight: bold; font-size: 12px; color: #1B3A6B; margin-bottom: 3px; letter-spacing: 0.3px; }
  .psubtitle { text-align: center; font-size: 9px; color: #2E5DA8; font-weight: bold; margin-bottom: 8px; background: #EBF3FC; padding: 3px; border-radius: 2px; }
  .tw { flex: 1; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 0.4px solid #AAAAAA; padding: 5px 7px; }
  thead tr { background: #1B3A6B; color: white; }
  th { font-size: 9px; font-weight: bold; text-align: left; }
  .hnom { width: 45%; } .hfn { width: 38%; } .hobs { width: 17%; text-align: center; }
  .cn { font-size: 9px; font-weight: 600; color: #1a1a1a; }
  .cf { font-size: 8.5px; color: #333; }
  .co { font-size: 8px; text-align: center; color: #2E5DA8; font-weight: bold; }
  tr.alt td { background: #EBF3FC; }
  .spacer { flex: 1; }
  .footer-sigs { display: flex; justify-content: space-around; font-size: 8px; color: #333; border-top: 0.5px solid #1B3A6B; padding-top: 6px; margin-top: 10px; padding-bottom: 5px; }
</style></head><body>${pages}</body></html>`;
}

// ══════════════════════════════════════════════
//  PDF 2 — PLANNING D'ACTIVITÉ (PAYSAGE A4)
// ══════════════════════════════════════════════
function buildPdfPlanning(svc, groupes, conges, year, month, leaveTypes) {
  const mn   = MOIS_FR[month - 1];
  const days = getDays(year, month);
  
  // Générer le CSS dynamique pour les types de congés
  const dynamicCss = leaveTypes.map(t => `
    .${t.code} { background:${t.color}22 !important; color:${t.color}; font-weight:700; }
  `).join("");

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
            <thead><tr>
              <th class="hn-nom">Nom et Prénom</th>
              <th class="hn-grd">Grade</th>
              ${gg.hasEquipe ? '<th class="hn-eq">Éq.</th>' : ""}
              ${dayHdrs}
            </tr></thead>
            <tbody>${trows}</tbody>
          </table>
        </div>
        ${pdfLegend()}
      </div>
    `;
  }).join("");
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/>
<style>
  @page { size: A4 landscape; margin: 9mm 11mm 9mm 11mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 6.5px; color: #111; }
  .page { page-break-after: always; display: flex; flex-direction: column; min-height: 178mm; }
  .page:last-child { page-break-after: auto; }
  .ph { text-align: center; margin-bottom: 2px; }
  .ph-rep { font-size: 6px; color: #222; } .ph-min { font-size: 6px; color: #222; margin-top: 1px; }
  .ph-hosp { font-size: 7px; font-weight: bold; color: #1B3A6B; margin-top: 2px; }
  .sigs-top { display: flex; justify-content: space-between; align-items: center; font-size: 6px; color: #444; border-top: 0.5px solid #1B3A6B; border-bottom: 0.5px solid #1B3A6B; padding: 2px 0; margin-bottom: 3px; }
  .unite { font-weight: bold; font-size: 7px; color: #1B3A6B; }
  .ptitle { text-align: center; font-weight: bold; font-size: 8.5px; color: #1B3A6B; margin-bottom: 1px; }
  .psubtitle { text-align: center; font-size: 7px; color: #2E5DA8; font-weight: bold; margin-bottom: 4px; background: #EBF3FC; padding: 2px; }
  .tw { flex: 1; overflow: hidden; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th, td { border: 0.25px solid #AAAAAA; text-align: center; vertical-align: middle; padding: 1px 0; overflow: hidden; }
  .hn-nom { background:#1B3A6B; color:#fff; font-size:6px; width:90px; text-align:left; padding-left:3px; }
  .hn-grd { background:#1B3A6B; color:#fff; font-size:6px; width:82px; text-align:left; padding-left:3px; }
  .hn-eq  { background:#1B3A6B; color:#fff; font-size:6px; width:13px; }
  .dh     { background:#D6E4F7; color:#1B3A6B; font-weight:bold; font-size:5px; }
  .dh span{ display:block; font-size:4.5px; }
  .dwe    { background:#EDEDED; color:#555; }
  .cn { text-align:left; padding:1px 3px; font-size:6px; font-weight:bold; }
  .cg { text-align:left; padding:1px 2px; font-size:5.5px; }
  .ce { font-size:6px; font-weight:bold; color:#1B3A6B; }
  .cday { font-size:6px; height:13px; }
  .cwe  { background:#EDEDED; color:#777; }
  ${dynamicCss}
  .G  { background:#FFCDD2 !important; color:#B71C1C; }
  .RE { background:#FFF9C4 !important; color:#7B6000; }
  .C  { background:#C8E6C9 !important; color:#1B5E20; }
  .CM { background:#F8BBD0 !important; color:#880E4F; }
  .M  { background:#FCE4EC !important; color:#880E4F; }
  .F  { background:#E0F7FA !important; color:#006064; font-weight:700; }
  .leg { display: flex; justify-content: space-between; font-size: 6px; color: #333; margin-top: 4px; border-top: 0.3px solid #ccc; padding-top: 3px; }
  .nb { font-size: 5.5px; color: #2E5DA8; margin-top: 2px; }
</style></head><body>${pages}</body></html>`;
}

// ══════════════════════════════════════════════
//  APP
// ══════════════════════════════════════════════
export default function App() {
  // ── LOGIN ──
  const [loggedIn,    setLoggedIn]    = useState(false);
  const [service,     setService]     = useState(null);
  const [inputCode,   setInputCode]   = useState("RHUMA01");
  const [inputNom,    setInputNom]    = useState("Nouveau Service");
  const [inputEtab,   setInputEtab]   = useState("Établissement");
  const [loginMsg,    setLoginMsg]    = useState("");
  const [loginBusy,   setLoginBusy]   = useState(false);
  const [loginTab,    setLoginTab]    = useState("join");

  // ── PLANNING ──
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
  const [planStatus, setPlanStatus] = useState("loading"); // loading, saved, new
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
  const [leaveModal, setLeaveModal] = useState(null); // { gid, mi, name, day }
  const [lmType, setLmType] = useState("C");
  const [lmStart, setLmStart] = useState(1);
  const [lmEnd, setLmEnd] = useState(1);
  const chatEnd = useRef(null);

  const mn      = MOIS_FR[month-1];
  const days    = getDays(year,month);
  const g       = groupes[gi] || null;
  const eqDebut = computedEqDebut || equipeDebut(year, month, ordre);
  const effectiveChatApiKey       = chatApiKey.trim() || DEFAULT_CHAT_API_KEY.trim();
  const effectiveChatApiKeySource = chatApiKey.trim() ? chatApiKeySource : (DEFAULT_CHAT_API_KEY.trim() ? "env" : "none");
  const chatReady = Boolean(effectiveChatApiKey);
  const chatStatusTone = chatReady
    ? { bg:"rgba(34,197,94,.12)", border:"rgba(34,197,94,.35)", color:"#86efac" }
    : { bg:"rgba(239,68,68,.10)", border:"rgba(239,68,68,.28)", color:"#fca5a5" };
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
      const { data, error } = await db.from("service_leave_types")
        .select("*").eq("service_id", serviceId).order("sort_order");
      if (error) throw error;
      if (data && data.length > 0) {
        setLeaveTypes(data);
      } else {
        // Seed and reload if empty
        await db.rpc("seed_service_leave_types", { target_service_id: serviceId });
        const { data: seeded } = await db.from("service_leave_types")
          .select("*").eq("service_id", serviceId).order("sort_order");
        setLeaveTypes(seeded || []);
      }
    } catch (e) {
      console.error("Erreur types congés:", e);
      if (isMissingRelationError(e)) {
        setSaveMsg("⚠️ Table 'service_leave_types' manquante. Vérifiez vos migrations Supabase.");
      }
    }
    finally { setLtBusy(false); }
  }, []);

  const loadHolidays = useCallback(async (serviceId) => {
    if (!serviceId) return;
    setHBusy(true);
    try {
      const db = getSupabaseClient();
      const { data, error } = await db.from("service_holidays")
        .select("*").eq("service_id", serviceId).order("mois, jour");
      if (error) throw error;
      setServiceHolidays(data || []);
    } catch (e) { console.error("Erreur fériés:", e); }
    finally { setHBusy(false); }
  }, []);

  async function addLeaveType() {
    if (!ltForm.code.trim() || !ltForm.label.trim() || ltBusy) return;
    setLtBusy(true);
    try {
      const db = getSupabaseClient();
      const { data, error } = await db.from("service_leave_types").insert({
        service_id: service.id,
        code: ltForm.code.trim().toUpperCase(),
        label: ltForm.label.trim(),
        color: ltForm.color,
        sort_order: leaveTypes.length * 10 + 10
      }).select().single();
      if (error) throw error;
      setLeaveTypes(prev => [...prev, data]);
      setLtForm({ code: "", label: "", color: "#3b82f6" });
    } catch (e) {
      alert(isMissingRelationError(e) ? "La table 'service_leave_types' est manquante dans votre base Supabase. Veuillez exécuter les migrations SQL." : e.message);
    } finally { setLtBusy(false); }
  }

  async function delLeaveType(id) {
    if (ltBusy) return;
    setLtBusy(true);
    try {
      const db = getSupabaseClient();
      const { error } = await db.from("service_leave_types").delete().eq("id", id);
      if (error) throw error;
      setLeaveTypes(prev => prev.filter(t => t.id !== id));
    } catch (e) {
      alert(isMissingRelationError(e) ? "La table 'service_leave_types' est manquante dans votre base Supabase. Veuillez exécuter les migrations SQL." : e.message);
    } finally { setLtBusy(false); }
  }

  useEffect(() => {
    if (service?.id) {
      loadHolidays(service.id);
      loadLeaveTypes(service.id);
    }
  }, [service?.id, loadHolidays, loadLeaveTypes]);

  async function addHoliday() {
    if (!hLabel.trim() || hBusy) return;
    setHBusy(true);
    try {
      const db = getSupabaseClient();
      const { data, error } = await db.from("service_holidays").insert({
        service_id: service.id, mois: hMonth, jour: hDay, label: hLabel.trim()
      }).select().single();
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
            // On ne remplace pas une garde "G"
            if (nc[k] !== "G") { nc[k] = "F"; count++; }
          }
        }
      });
    });
    setConges(nc);
    setSaveMsg(`✅ ${count} jours fériés appliqués au tableau.`);
  }

  const loadServiceConfig = useCallback(async(serviceId, options = {})=>{
    const { seedIfEmpty = true, silent = false } = options;
    if(!serviceId){ setGroupes([]); setGi(0); if(!silent) setServiceConfigMsg(""); return []; }
    if(!silent){ setServiceConfigBusy(true); setServiceConfigMsg("⏳ Chargement du personnel…"); }
    try {
      const db = getSupabaseClient();
      let { data: groupRows, error: groupsError } = await db
        .from("service_groups").select("id,code,label,subtitle,color,has_equipe,sort_order")
        .eq("service_id", serviceId).order("sort_order", { ascending: true });
      if (groupsError) throw groupsError;

      if ((groupRows || []).length === 0 && seedIfEmpty) {
        const { error: seedError } = await db.rpc("seed_service_defaults", { target_service_id: serviceId });
        if (seedError) throw seedError;
        const { data: seededGroups, error: reloadError } = await db
          .from("service_groups").select("id,code,label,subtitle,color,has_equipe,sort_order")
          .eq("service_id", serviceId).order("sort_order", { ascending: true });
        if (reloadError) throw reloadError;
        groupRows = seededGroups || [];
      }

      const groupIds = (groupRows || []).map(row => row.id);
      let memberRows = [];
      if (groupIds.length > 0) {
        const { data, error } = await db
          .from("service_members").select("id,group_id,nom,grade,equipe,sort_order")
          .in("group_id", groupIds).order("sort_order", { ascending: true });
        if (error) throw error;
        memberRows = data || [];
      }

      const mappedGroups = mapServiceData(groupRows || [], memberRows);
      setGroupes(mappedGroups);
      setGi(prev => mappedGroups.length === 0 ? 0 : Math.min(prev, mappedGroups.length - 1));
      if(!silent) setServiceConfigMsg(mappedGroups.length ? "" : "⚠️ Aucun groupe configuré dans Supabase.");
      return mappedGroups;
    } catch (error) {
      setGroupes([]); setGi(0);
      if(!silent) setServiceConfigMsg(`❌ ${isMissingRelationError(error)
        ? "Les tables service_groups/service_members manquent dans Supabase."
        : dbError(error, "Chargement du personnel impossible.")}`);
      return [];
    } finally {
      if(!silent) setServiceConfigBusy(false);
    }
  },[]);

  // ── Auto-gardes pour tous les groupes avec rotation ──
  useEffect(()=>{
    if(!autoMode) return;
    setConges(prev=>{
      const n={...prev};
      groupes.forEach(gg=>{
        if(!gg.hasEquipe) return;
        // On nettoie les gardes auto "G" existantes pour ce groupe
        Object.keys(n).filter(k=>k.startsWith(`${gg.id}:`)&&n[k]==="G").forEach(k=>delete n[k]);
        // On recalcule
        const r=calcAutoGardes(year,month,gg.membres,ordre,computedEqDebut);
        Object.entries(r).forEach(([key,code])=>{
          const [mi,j]=key.split(":").map(Number);
          const fk=ck(gg.id,mi,j);
          if(!n[fk]) n[fk]=code;
        });
      });
      return n;
    });
  },[year,month,ordre,autoMode,computedEqDebut,groupes]);

  useEffect(()=>{
    if(!service?.id){ setGroupes([]); setGi(0); setServiceConfigBusy(false); setServiceConfigMsg(""); return; }
    loadServiceConfig(service.id);
  },[service?.id, loadServiceConfig]);

  // ── Chargement Auto ou Fill ──
  useEffect(() => {
    let active = true;
    async function syncPlanning() {
      if (!service?.id || groupes.length === 0) return;
      setPlanStatus("loading");
      setSaveMsg("⏳ Synchronisation...");
      
      try {
        const db = getSupabaseClient();
        // 1. Tenter de charger le planning existant
        const { data: planningRows, error } = await db.from("plannings").select("id,groupe_id,ordre_equipes")
          .eq("service_id", service.id).eq("annee", year).eq("month" === "mois" ? "mois" : "mois", month); // fix for previous typo if any, but it's "mois"
        
        // Use "mois" correctly
        const { data: pRows, error: pErr } = await db.from("plannings").select("id,groupe_id,ordre_equipes")
          .eq("service_id", service.id).eq("annee", year).eq("mois", month);
          
        if (pErr) throw pErr;

        if (pRows && pRows.length > 0) {
          // PLANNING EXISTE -> Charger
          const planningIds = pRows.map(r => r.id);
          const planningGroupById = Object.fromEntries(pRows.map(r => [r.id, r.groupe_id]));
          const storedOrdre = pRows.find(r => Array.isArray(r.ordre_equipes) && r.ordre_equipes.length)?.ordre_equipes;
          
          const { data: rotationRow } = await db.from("rotation_state").select("equipe_debut, ordre_equipes, hygiene_start_mi")
            .eq("service_id", service.id).eq("annee", year).eq("mois", month).maybeSingle();

          let congesRows = [];
          if (planningIds.length > 0) {
            const { data, error: ce } = await db.from("conges")
              .select("planning_id,membre_index,membre_nom,membre_equipe,jour,code").in("planning_id", planningIds);
            if (ce) throw ce;
            congesRows = data || [];
          }

          if (!active) return;
          const nc = {};
          congesRows.forEach(row => { const groupeId = planningGroupById[row.planning_id]; if (groupeId) nc[ck(groupeId, row.membre_index, row.jour)] = row.code; });
          
          const effectiveOrdre = storedOrdre || rotationRow?.ordre_equipes || ordre;
          setOrdre(effectiveOrdre);
          setComputedEqDebut(rotationRow?.equipe_debut || equipeDebut(year, month, effectiveOrdre));
          setHygieneStartMi(rotationRow?.hygiene_start_mi || 0);

          setConges(nc);
          setPlanStatus("saved");
          setSaveMsg("");
        } else {
          // PLANNING N'EXISTE PAS -> Auto-Fill avec continuité
          if (!active) return;
          const hygieneCount = groupes.find(x => x.id === "hygiene")?.membres.length || 0;
          const cont = await getContinuityState(service.id, year, month, ordre, hygieneCount);
          if (!active) return;
          setComputedEqDebut(cont.eqDebut);
          setHygieneStartMi(cont.hygieneStartMi);
          autoFillInternal(cont.eqDebut, cont.hygieneStartMi);
          setPlanStatus("new");
          setSaveMsg("✨ Nouveau mois : planning auto-rempli.");
        }
      } catch (err) {
        if (active) {
          setPlanStatus("new");
          setSaveMsg(`⚠️ Erreur chargement : ${err.message}`);
        }
      }
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
          const dw    = getDow(year, month, d);
          const we    = isWE(dw);
          const ferie = isFerie(month, d);
          const k     = ck(gg.id, mi, d);

          if (gg.id === "hygiene") {
            // Géré par calcMemberRotation plus bas
          } else if (ferie) {
            newConges[k] = "F";
          } else if (we) {
            newConges[k] = "RE";
          } else {
            newConges[k] = "N";
          }
        }
      });
    });

    // Rotation Equipes (Médecins, etc.)
    groupes.forEach(gg => {
      if (gg.hasEquipe && gg.id !== "hygiene") {
        const gardes = calcAutoGardes(year, month, gg.membres, ordre, effectiveDebut);
        Object.entries(gardes).forEach(([key, code]) => {
          const [mi, j] = key.split(":").map(Number);
          newConges[ck(gg.id, mi, j)] = code;
        });
      }
    });

    // Rotation Membres (Hygiène)
    const hygGroup = groupes.find(x => x.id === "hygiene");
    if (hygGroup) {
      const gardes = calcMemberRotation(year, month, hygGroup.membres, effectiveHygieneStart);
      Object.entries(gardes).forEach(([key, code]) => {
        const [mi, j] = key.split(":").map(Number);
        newConges[ck("hygiene", mi, j)] = code;
      });
    }

    setConges(newConges);
  }

  function autoFill() {
    autoFillInternal();
    setSaveMsg("✅ Planning réinitialisé — n'oubliez pas de sauvegarder.");
    setPlanStatus("new");
  }

  function resetWorkspace(svc) {
    if (svc) {
      setService(svc);
      setLoggedIn(true);
      setConges({});
      setGroupes([]);
      setTab("planning");
    } else {
      setService(null);
      setLoggedIn(false);
      setConges({});
      setGroupes([]);
    }
  }

  function applyLeave() {
    if (!leaveModal) return;
    const { gid, mi } = leaveModal;
    const nc = { ...conges };
    for (let d = lmStart; d <= lmEnd; d++) {
      nc[ck(gid, mi, d)] = lmType;
    }
    setConges(nc);
    setLeaveModal(null);
    setSaveMsg("⏳ Congé appliqué localement. N'oubliez pas de sauvegarder.");
  }

  // ── LOGIN ──
  function doLogin(svc) { resetWorkspace(svc); setLoginMsg(""); }
  async function joinService() {
    const code = inputCode.trim().toUpperCase();
    if (!code) { setLoginMsg("❌ Entrez un code."); return; }
    setLoginBusy(true); setLoginMsg("⏳ Recherche…");
    try {
      const db = getSupabaseClient();
      const { data: existing, error } = await db.from("services").select("id,code,nom,etablissement")
        .eq("code", code).maybeSingle();
      if (error) throw error;
      if (existing) { doLogin(existing); return; }
      if (code === SERVICE_DEFAUT.code) {
        const { data: created, error: createError } = await db.from("services")
          .upsert(SERVICE_DEFAUT, { onConflict: "code" }).select("id,code,nom,etablissement").single();
        if (createError) throw createError;
        doLogin(created); return;
      }
      setLoginMsg("❌ Service introuvable.");
    } catch (error) {
      setLoginMsg(`❌ ${dbError(error, "Erreur de connexion Supabase.")}`);
    } finally { setLoginBusy(false); }
  }
  async function createService() {
    const code=inputCode.trim().toUpperCase(), nom=inputNom.trim(), etab=inputEtab.trim();
    if(!code||!nom||!etab){ setLoginMsg("❌ Remplissez tous les champs."); return; }
    setLoginBusy(true); setLoginMsg("⏳ Création du service…");
    try {
      const db = getSupabaseClient();
      const svc = { id: crypto.randomUUID(), code, nom, etablissement: etab };
      const { data, error } = await db.from("services").upsert(svc, { onConflict: "code" })
        .select("id,code,nom,etablissement").single();
      if (error) throw error;
      doLogin(data);
    } catch (error) {
      setLoginMsg(`❌ ${dbError(error, "Création impossible.")}`);
    } finally { setLoginBusy(false); }
  }

  // ── PLANNING ──
  function setCode(gid,mi,jour,v){
    setConges(prev=>{ const k=ck(gid,mi,jour),n={...prev}; if(!v||v===prev[k])delete n[k]; else n[k]=v.toUpperCase(); return n; });
  }
  function addM(i){
    setServiceConfigMsg("");
    setGroupes(p=>p.map((gg,x)=>x!==i?gg:{...gg,membres:[...gg.membres,{id:crypto.randomUUID(),nom:"Nouveau",grade:"Grade",equipe:gg.hasEquipe?DEFAULT_ROTATION_ORDER[0]:null}]}));
  }
  function delM(i,mi){
    const groupId = groupes[i]?.id;
    setServiceConfigMsg("");
    setGroupes(p=>p.map((gg,x)=>x!==i?gg:{...gg,membres:gg.membres.filter((_,j)=>j!==mi)}));
    if(groupId) setConges(prev=>shiftCongesAfterMemberDelete(prev, groupId, mi));
  }
  function updM(i,mi,f,v){
    setServiceConfigMsg("");
    setGroupes(p=>p.map((gg,x)=>x!==i?gg:{...gg,membres:gg.membres.map((m,j)=>j!==mi?m:{...m,[f]:v})}));
  }
  function moveM(i,mi,targetGroupId){
    const member = groupes[i].membres[mi];
    const targetGroupIndex = groupes.findIndex(gg=>gg.id===targetGroupId);
    if(targetGroupIndex<0) return;
    
    setGroupes(p=>{
      const next = [...p];
      // Supprimer du groupe source
      next[i] = {...next[i], membres: next[i].membres.filter((_,j)=>j!==mi)};
      // Ajouter au groupe cible
      next[targetGroupIndex] = {...next[targetGroupIndex], membres: [...next[targetGroupIndex].membres, {...member, equipe: next[targetGroupIndex].hasEquipe ? DEFAULT_ROTATION_ORDER[0] : null}]};
      return next;
    });
    setConges(prev=>shiftCongesAfterMemberDelete(prev, groupes[i].id, mi));
    setServiceConfigMsg(`↪️ ${member.nom} déplacé vers ${groupes[targetGroupIndex].label}`);
  }

  function dropEq(t){ if(!dragEq||dragEq===t)return; setOrdre(p=>{ const a=[...p],fi=a.indexOf(dragEq),ti=a.indexOf(t); a.splice(fi,1);a.splice(ti,0,dragEq);return a; }); setDragEq(null); }

  async function resetGroups() {
    if (!service?.id || !window.confirm("⚠️ Voulez-vous vraiment réinitialiser les groupes ? Cela supprimera le personnel actuel.")) return;
    setServiceConfigBusy(true); setServiceConfigMsg("⏳ Réinitialisation…");
    try {
      const db = getSupabaseClient();
      const { error: delError } = await db.from("service_groups").delete().eq("service_id", service.id);
      if (delError) throw delError;
      await loadServiceConfig(service.id);
      setServiceConfigMsg("✅ Groupes réinitialisés.");
    } catch (e) { setServiceConfigMsg(`❌ ${dbError(e, "Erreur réinitialisation")}`); }
    finally { setServiceConfigBusy(false); }
  }

  async function savePersonnelConfig(){
    if(!service?.id) return;
    setPersonnelSaving(true); setServiceConfigMsg("⏳ Sauvegarde du personnel…");
    try {
      const db = getSupabaseClient();
      const updatedAt = new Date().toISOString();
      const groupPayload = groupes.map((group, index) => {
        const payload = { service_id: service.id, code: group.id, label: group.label, subtitle: group.subtitle, color: group.color, has_equipe: group.hasEquipe, sort_order: index, updated_at: updatedAt };
        if (group.dbId) payload.id = group.dbId;
        return payload;
      });
      const { data: savedGroups, error: groupError } = await db.from("service_groups")
        .upsert(groupPayload, { onConflict: "service_id,code" }).select("id,code");
      if (groupError) throw groupError;

      const groupIdByCode = Object.fromEntries((savedGroups || []).map(row => [row.code, row.id]));
      const persistedGroupIds = Object.values(groupIdByCode);
      let existingMembers = [];
      if (persistedGroupIds.length > 0) {
        const { data, error } = await db.from("service_members").select("id,group_id").in("group_id", persistedGroupIds);
        if (error) throw error;
        existingMembers = data || [];
      }
      const memberPayload = groupes.flatMap(group => {
        const groupId = groupIdByCode[group.id]; if (!groupId) return [];
        return group.membres.map((member, index) => ({
          id: member.id || crypto.randomUUID(), group_id: groupId, nom: member.nom, grade: member.grade,
          equipe: group.hasEquipe ? (member.equipe || DEFAULT_ROTATION_ORDER[0]) : null,
          sort_order: index, updated_at: updatedAt,
        }));
      });
      const persistedMemberIds = new Set(memberPayload.map(m => m.id));
      const memberIdsToDelete = existingMembers.filter(m => !persistedMemberIds.has(m.id)).map(m => m.id);
      if (memberIdsToDelete.length > 0) {
        const { error } = await db.from("service_members").delete().in("id", memberIdsToDelete);
        if (error) throw error;
      }
      if (memberPayload.length > 0) {
        const { error } = await db.from("service_members").upsert(memberPayload);
        if (error) throw error;
      }
      await loadServiceConfig(service.id, { seedIfEmpty: false, silent: true });
      setServiceConfigMsg(`✅ Personnel synchronisé (${memberPayload.length} membre(s)).`);
    } catch (error) {
      setServiceConfigMsg(`❌ ${dbError(error, "Sauvegarde du personnel impossible.")}`);
    } finally { setPersonnelSaving(false); }
  }

  // ── SAVE (accepte override + mode silencieux pour l'IA) ──
  async function save(congesOverride = null, silent = false){
    const effectiveConges = congesOverride ?? conges;
    if(!service) return;
    if(groupes.length===0){ if(!silent) setSaveMsg("❌ Aucun groupe chargé depuis Supabase."); return; }
    if(!silent){ setSaving(true); setSaveMsg("⏳ Sauvegarde…"); }

    const rows=[];
    groupes.forEach(gg=>gg.membres.forEach((m,mi)=>{
      for(let j=1;j<=days;j++){
        const c=effectiveConges[ck(gg.id,mi,j)]; if(c) rows.push({gid:gg.id,mi,nom:m.nom,eq:m.equipe,j,c});
      }
    }));
    try {
      const db = getSupabaseClient();
      const updatedAt = new Date().toISOString();
      const planningPayload = groupes.map(({ id: groupeId }) => ({
        service_id: service.id, annee: year, mois: month, groupe_id: groupeId, ordre_equipes: ordre, updated_at: updatedAt,
      }));
      const { data: planningRows, error: planningError } = await db.from("plannings")
        .upsert(planningPayload, { onConflict: "service_id,annee,mois,groupe_id" }).select("id,groupe_id");
      if (planningError) throw planningError;

      const planningIdByGroup = Object.fromEntries((planningRows || []).map(row => [row.groupe_id, row.id]));
      const planningIds = Object.values(planningIdByGroup);
      if (planningIds.length > 0) {
        const { error } = await db.from("conges").delete().in("planning_id", planningIds);
        if (error) throw error;
      }
      const congesPayload = rows.map(r => {
        const planningId = planningIdByGroup[r.gid]; if (!planningId) return null;
        return { planning_id: planningId, membre_index: r.mi, membre_nom: r.nom, membre_equipe: r.eq, jour: r.j, code: r.c, is_auto: autoMode && r.gid === "paramedical" && r.c === "G" };
      }).filter(Boolean);
      if (congesPayload.length > 0) {
        const { error } = await db.from("conges").insert(congesPayload);
        if (error) throw error;
      }
      const { error: rotationError } = await db.from("rotation_state").upsert({
        service_id: service.id, annee: year, mois: month, equipe_debut: eqDebut, ordre_equipes: ordre,
        hygiene_start_mi: hygieneStartMi,
      }, { onConflict: "service_id,annee,mois" });
      if (rotationError) throw rotationError;

      if(!silent) setSaveMsg(`✅ ${rows.length} codes sauvegardés`);
    } catch (error) {
      if(!silent) setSaveMsg(`❌ ${dbError(error, "Erreur sauvegarde")}`);
      throw error;
    } finally {
      if(!silent) setSaving(false);
    }
  }

  // ── HISTORIQUE ──
  const loadHisto=useCallback(async()=>{
    if(!service) return; setHistoBusy(true);
    try {
      const db = getSupabaseClient();
      const { data, error } = await db.from("plannings").select("id,annee,mois,groupe_id,updated_at")
        .eq("service_id", service.id).order("annee",{ascending:false}).order("mois",{ascending:false});
      if (error) throw error;
      setHisto(data || []);
    } catch { setHisto([]); } finally { setHistoBusy(false); }
  },[service]);
  useEffect(()=>{ if(tab==="historique") loadHisto(); },[tab,loadHisto]);

  async function loadPlan(annee,mois){
    addA("⏳ Chargement…");
    try {
      const db = getSupabaseClient();
      const { data: planningRows, error } = await db.from("plannings").select("id,groupe_id,ordre_equipes")
        .eq("service_id", service.id).eq("annee", annee).eq("mois", mois);
      if (error) throw error;
      if (!planningRows?.length) { addA("❌ Aucun planning trouvé."); return; }

      const planningIds = planningRows.map(r => r.id);
      const planningGroupById = Object.fromEntries(planningRows.map(r => [r.id, r.groupe_id]));
      const storedOrdre = planningRows.find(r => Array.isArray(r.ordre_equipes) && r.ordre_equipes.length)?.ordre_equipes;

      let congesRows = [];
      if (planningIds.length > 0) {
        const { data, error: ce } = await db.from("conges")
          .select("planning_id,membre_index,membre_nom,membre_equipe,jour,code").in("planning_id", planningIds);
        if (ce) throw ce;
        congesRows = data || [];
      }
      const nc={};
      congesRows.forEach(row=>{ const groupeId = planningGroupById[row.planning_id]; if(groupeId) nc[ck(groupeId,row.membre_index,row.jour)]=row.code; });
      if(storedOrdre){ setOrdre(storedOrdre); } else {
        const { data: rotationRow } = await db.from("rotation_state").select("ordre_equipes")
          .eq("service_id",service.id).eq("annee",annee).eq("mois",mois).maybeSingle();
        if(Array.isArray(rotationRow?.ordre_equipes)&&rotationRow.ordre_equipes.length) setOrdre(rotationRow.ordre_equipes);
      }
      setConges(nc); setYear(annee); setMonth(mois); setAutoMode(false); setTab("planning");
      addA(`📂 Planning ${MOIS_FR[mois-1]} ${annee} chargé.`);
    } catch(error) { addA(`❌ ${dbError(error,"Chargement impossible.")}`); }
  }
  async function delPlan(annee,mois){
    try {
      const db = getSupabaseClient();
      const { data: planningRows } = await db.from("plannings").select("id").eq("service_id",service.id).eq("annee",annee).eq("mois",mois);
      const planningIds=(planningRows||[]).map(r=>r.id);
      if(planningIds.length>0) await db.from("conges").delete().in("planning_id",planningIds);
      await db.from("rotation_state").delete().eq("service_id",service.id).eq("annee",annee).eq("mois",mois);
      await db.from("plannings").delete().eq("service_id",service.id).eq("annee",annee).eq("mois",mois);
      addA("🗑️ Supprimé."); loadHisto();
    } catch(error) { addA(`❌ ${dbError(error,"Suppression impossible.")}`); }
  }

  // ── CHAT ──
  function addA(t){ setMsgs(p=>[...p,{r:"a",t}]); }

  async function saveChatApiKey(){
    const nextKey = chatApiKeyInput.trim();
    if(!nextKey){ setChatApiKeyMsg("❌ Entrez une clé API Groq."); return; }
    if(!service?.id){ setChatApiKeyMsg("❌ Aucun service actif."); return; }
    setChatApiKeyBusy(true); setChatApiKeyMsg("⏳ Sauvegarde…");
    try{
      const db = getSupabaseClient();
      const { error } = await db.from(CHAT_SETTINGS_TABLE).upsert({
        service_id: service.id, provider: CHAT_PROVIDER, api_key: nextKey,
        api_key_hint: chatKeyPreview(nextKey), updated_at: new Date().toISOString(),
      }, { onConflict: "service_id,provider" });
      if(error) throw error;
      setChatApiKey(nextKey); setChatApiKeyInput(nextKey); setChatApiKeySource("supabase");
      setChatApiKeyMsg("✅ Clé API Groq sauvegardée.");
    }catch(error){
      if(isMissingRelationError(error)) setChatApiKeyMsg("⚠️ La table service_ai_settings manque dans Supabase.");
      else setChatApiKeyMsg(`⚠️ ${dbError(error,"Sauvegarde indisponible.")}`);
    }finally{ setChatApiKeyBusy(false); }
  }
  async function clearChatApiKey(){
    if(!service?.id) return;
    if(!chatApiKey.trim()){ setChatApiKeyMsg("⚠️ Aucune clé enregistrée."); return; }
    setChatApiKeyBusy(true); setChatApiKeyMsg("⏳ Suppression…"); setShowChatApiKey(false);
    try{
      const db = getSupabaseClient();
      const { error } = await db.from(CHAT_SETTINGS_TABLE).delete().eq("service_id",service.id).eq("provider",CHAT_PROVIDER);
      if(error) throw error;
      setChatApiKey(""); setChatApiKeyInput(""); setChatApiKeySource(DEFAULT_CHAT_API_KEY.trim()?"env":"none");
      setChatApiKeyMsg("🗑️ Clé supprimée.");
    }catch(error){ setChatApiKeyMsg(`⚠️ ${dbError(error,"Suppression impossible.")}`); }
    finally{ setChatApiKeyBusy(false); }
  }

  async function sendChat(){
    if(!chatReady){ setChatApiKeyMsg("❌ Configurez une clé API Groq."); return; }
    if(!chatIn.trim()||chatBusy) return;
    const txt = chatIn.trim();
    setChatIn(""); setMsgs(p=>[...p,{r:"u",t:txt}]); setChatBusy(true);

    // ── Contexte complet pour Groq avec indices explicites ──
    const membresList = groupes.map(gg =>
      gg.membres.map((m, mi) =>
        `  [gid="${gg.id}" mi=${mi}] ${m.nom}${m.equipe ? ` (Équipe ${m.equipe})` : ""} — ${m.grade}`
      ).join("\n")
    ).join("\n");

    const congesActuels = groupes.flatMap(gg =>
      gg.membres.flatMap((m, mi) =>
        Object.entries(conges)
          .filter(([k]) => k === `${gg.id}:${mi}:` || k.startsWith(`${gg.id}:${mi}:`))
          .map(([k,v]) => `  ${m.nom} jour ${k.split(":")[2]}=${v}`)
      )
    ).join("\n") || "  (aucun)";

    // ── System prompt strict : JSON pur, zéro markdown ──
    const systemPrompt = `Tu es un agent de planning hospitalier. Tu gères les congés et activités du personnel.
SERVICE : ${service?.nom} — ${mn} ${year}

MEMBRES (à utiliser pour les mises à jour) :
${membresList}

CONGÉS ACTUELS :
${congesActuels}

CODES : G=Garde RE=Récupération C=Congé CM=MaladieMaladie M=Maternité N=Normal F=Férié

═══ RÈGLES ABSOLUES ═══
1. Réponds UNIQUEMENT avec un objet JSON valide. ZÉRO texte avant ou après. ZÉRO markdown. ZÉRO backticks.
2. Pour une PLAGE de jours (ex: "du 5 au 12") → génère UNE entrée par jour dans le tableau updates[].
   Exemple "BOUZIANE congé du 5 au 12" → 8 entrées jours 5,6,7,8,9,10,11,12 toutes avec code "C".
3. Cherche le membre par son nom (partiel accepté) et utilise le bon gid et mi.

FORMAT modification :
{"action":"update","updates":[{"gid":"medecins","mi":2,"jour":5,"code":"C"},{"gid":"medecins","mi":2,"jour":6,"code":"C"},...tous les jours...],"msg":"résumé en français"}

FORMAT réponse informative :
{"action":"msg","msg":"ta réponse ici"}`;

    try {
      const raw = await generateWithGroq({ apiKey: effectiveChatApiKey, systemPrompt, userPrompt: txt });

      // ── Extraction JSON robuste ──
      const p = extractJSON(raw);

      if (p.action === "update" && Array.isArray(p.updates) && p.updates.length > 0) {
        // 1. Calculer les nouveaux congés SYNCHRONIQUEMENT (évite le timing issue React)
        const newConges = { ...conges };
        p.updates.forEach(({ gid, mi, jour, code }) => {
          const k = ck(gid, mi, jour);
          if (!code) delete newConges[k];
          else newConges[k] = code.toUpperCase();
        });

        // 2. Mettre à jour le state React
        setConges(newConges);
        addA(`✅ ${p.msg}\n⏳ Synchronisation Supabase…`);

        // 3. Persister en Supabase avec les nouvelles valeurs (mode silencieux)
        try {
          await save(newConges, true);
          addA(`💾 ${p.updates.length} code(s) mis à jour en base.`);
        } catch(saveErr) {
          addA(`⚠️ Tableau mis à jour mais erreur Supabase : ${saveErr.message}`);
        }

      } else if (p.action === "msg") {
        addA(p.msg || raw);
      } else {
        addA(p.msg || raw);
      }

    } catch(e) {
      addA("⚠️ Erreur Groq : " + e.message);
    }

    setChatBusy(false);
    setTimeout(()=>chatEnd.current?.scrollIntoView({behavior:"smooth"}),100);
  }

  // ── PDF ──
  function openPdfListe() {
    setPdfMenu(false);
    const win = window.open("","_blank");
    win.document.write(buildPdfListe(service,groupes,year,month));
    win.document.close(); setTimeout(()=>win.print(),700);
  }
  function openPdfPlanning() {
    setPdfMenu(false);
    const win = window.open("","_blank");
    win.document.write(buildPdfPlanning(service,groupes,conges,year,month,leaveTypes));
    win.document.close(); setTimeout(()=>win.print(),700);
  }

  // ══════════════════════════════════════════════
  //  RENDER LOGIN
  // ══════════════════════════════════════════════
  if (!loggedIn) return (
    <div style={{minHeight:"100vh",background:"#050c1a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,gap:16,fontFamily:"system-ui,sans-serif"}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:52,marginBottom:8}}>🏥</div>
        <div style={{fontSize:24,fontWeight:800,color:"#f8fafc"}}>PlanningHospital</div>
        <div style={{fontSize:12,color:"#475569",marginTop:4}}>Plateforme SaaS · Supabase <span style={{color:"#22c55e"}}>●</span></div>
      </div>
      <div style={{display:"flex",gap:0,background:"rgba(255,255,255,.05)",borderRadius:10,padding:4,width:"100%",maxWidth:400}}>
        {[["join","🔑 Rejoindre"],["create","✨ Créer"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>{setLoginTab(id);setLoginMsg("");}} style={{flex:1,padding:"9px",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600,background:loginTab===id?"white":"transparent",color:loginTab===id?"#1e293b":"#64748b",boxShadow:loginTab===id?"0 1px 4px rgba(0,0,0,.2)":"none"}}>{lbl}</button>
        ))}
      </div>
      <div style={{width:"100%",maxWidth:400,background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.1)",borderRadius:14,padding:24,display:"flex",flexDirection:"column",gap:10}}>
        {loginTab==="join" ? <>
          <div style={{fontSize:12,color:"#64748b",marginBottom:4}}>Entrez le code de votre service :</div>
          <input value={inputCode} onChange={e=>setInputCode(e.target.value.toUpperCase())} onKeyDown={e=>e.key==="Enter"&&joinService()} placeholder="RHUMA01" style={{padding:"12px 14px",borderRadius:8,border:"1px solid rgba(255,255,255,.15)",background:"rgba(255,255,255,.07)",color:"white",fontSize:16,fontFamily:"monospace",letterSpacing:2,textAlign:"center",outline:"none"}}/>
          <button onClick={joinService} disabled={loginBusy} style={{padding:"13px",borderRadius:8,border:"none",cursor:"pointer",fontSize:14,fontWeight:700,background:"linear-gradient(135deg,#2563eb,#0891b2)",color:"white",marginTop:4,opacity:loginBusy?0.7:1}}>{loginBusy?"⏳ Recherche…":"→ Entrer"}</button>
        </> : <>
          <input value={inputCode} onChange={e=>setInputCode(e.target.value.toUpperCase())} placeholder="Code (ex: CARDIO01)" style={{...FLD,textTransform:"uppercase"}}/>
          <input value={inputNom} onChange={e=>setInputNom(e.target.value)} placeholder="Nom du service" style={FLD}/>
          <input value={inputEtab} onChange={e=>setInputEtab(e.target.value)} placeholder="Établissement" style={FLD}/>
          <button onClick={createService} disabled={loginBusy} style={{padding:"13px",borderRadius:8,border:"none",cursor:"pointer",fontSize:14,fontWeight:700,background:"linear-gradient(135deg,#059669,#0891b2)",color:"white",marginTop:4,opacity:loginBusy?0.7:1}}>{loginBusy?"⏳ Création…":"✨ Créer ce service"}</button>
        </>}
        {loginMsg&&<div style={{padding:"8px 12px",borderRadius:8,background:"rgba(239,68,68,.1)",border:"1px solid rgba(239,68,68,.3)",color:"#fca5a5",fontSize:12,textAlign:"center"}}>{loginMsg}</div>}
      </div>
      <div style={{fontSize:11,color:"#1e3a5f"}}>💡 Code de démo : <span style={{color:"#60a5fa",fontFamily:"monospace",fontWeight:700}}>RHUMA01</span></div>
    </div>
  );

  // ══════════════════════════════════════════════
  //  RENDER APP
  // ══════════════════════════════════════════════
  const TABS=[{id:"planning",icon:"📋",lbl:"Planning"},{id:"gardes",icon:"🔄",lbl:"Rotation"},{id:"config",icon:"⚙️",lbl:"Personnel"},{id:"types_conges",icon:"🏖️",lbl:"Congés"},{id:"feries",icon:"📅",lbl:"Fériés"},{id:"historique",icon:"🕓",lbl:"Historique"},{id:"chat",icon:"💬",lbl:"IA"}];
  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",background:"#070d1a",color:"#e2e8f0",fontFamily:"system-ui,sans-serif"}}>

      {/* ── HEADER ── */}
      <div style={{padding:"10px 18px",background:"rgba(255,255,255,.03)",borderBottom:"1px solid rgba(255,255,255,.07)",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <span style={{fontSize:22}}>🏥</span>
        <div>
          <div style={{fontWeight:700,fontSize:14,color:"#f8fafc"}}>{service.nom}</div>
          <div style={{fontSize:10,color:"#475569"}}>{service.etablissement} · <b style={{color:"#22c55e"}}>●</b> · <b style={{color:"#60a5fa"}}>{service.code}</b></div>
        </div>
        <select value={month} onChange={e=>setMonth(+e.target.value)} style={SEL}>
          {MOIS_FR.map((m,i)=><option key={i} value={i+1}>{m.charAt(0).toUpperCase()+m.slice(1)}</option>)}
        </select>
        <input type="number" value={year} onChange={e=>setYear(+e.target.value)} style={{...INP,width:76}}/>
        <div style={{padding:"3px 10px",borderRadius:20,background:planStatus==="new"?"rgba(59,130,246,.12)":"rgba(239,68,68,.12)",border:`1px solid ${planStatus==="new"?"#3b82f630":"#ef444430"}`,fontSize:10,color:planStatus==="new"?"#93c5fd":"#fca5a5"}}>
          {planStatus==="new" ? "✨ Nouveau" : "💾 Enregistré"} · 🔄 {mn.slice(0,3)}. → Éq.<b style={{marginLeft:4}}>{eqDebut}</b>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center",position:"relative"}}>

          {/* ── Bouton Auto-Fill ── */}
          <button
            onClick={autoFill}
            disabled={groupes.length===0}
            title="Remplir automatiquement : N (jour normal), RE (weekend/repos), G (gardes rotation), F (jours fériés)"
            style={{...BTN,background:"linear-gradient(135deg,#059669,#10b981)",fontSize:11,opacity:groupes.length===0?0.5:1}}
          >
            ⚡ Auto-Fill
          </button>

          <button onClick={()=>save()} disabled={saving||serviceConfigBusy||groupes.length===0} style={{...BTN,background:"linear-gradient(135deg,#1d4ed8,#0891b2)",fontSize:11,opacity:(saving||serviceConfigBusy||groupes.length===0)?0.7:1}}>{saving?"⏳…":"💾 Sauver"}</button>

          <div style={{position:"relative"}}>
            <button onClick={()=>groupes.length>0&&setPdfMenu(p=>!p)} style={{...BTN,background:"linear-gradient(135deg,#7c3aed,#1d4ed8)",fontSize:11}}>📄 PDF ▾</button>
            {pdfMenu && (
              <div style={{position:"absolute",right:0,top:"110%",zIndex:100,background:"#0f1d35",border:"1px solid rgba(255,255,255,.12)",borderRadius:8,overflow:"hidden",minWidth:180,boxShadow:"0 8px 32px rgba(0,0,0,.5)"}}>
                <button onClick={openPdfListe} style={{display:"block",width:"100%",padding:"10px 16px",border:"none",background:"transparent",color:"#e2e8f0",fontSize:12,textAlign:"left",cursor:"pointer",borderBottom:"1px solid rgba(255,255,255,.06)"}}>
                  📋 Liste du Personnel<div style={{fontSize:10,color:"#475569",marginTop:2}}>Portrait A4 · 1 page / groupe</div>
                </button>
                <button onClick={openPdfPlanning} style={{display:"block",width:"100%",padding:"10px 16px",border:"none",background:"transparent",color:"#e2e8f0",fontSize:12,textAlign:"left",cursor:"pointer"}}>
                  📅 Planning d'Activité<div style={{fontSize:10,color:"#475569",marginTop:2}}>Paysage A4 · Tableau 31 jours</div>
                </button>
              </div>
            )}
          </div>
          <button onClick={()=>resetWorkspace(null)} style={{...BTN,background:"rgba(255,255,255,.05)",color:"#64748b",fontSize:11}}>⬅</button>
        </div>
      </div>
      {saveMsg&&<div style={{padding:"5px 18px",fontSize:11,background:saveMsg.startsWith("✅")?"rgba(34,197,94,.07)":"rgba(239,68,68,.07)",color:saveMsg.startsWith("✅")?"#4ade80":"#f87171"}}>{saveMsg}</div>}

      {/* ── TABS ── */}
      <div style={{display:"flex",borderBottom:"1px solid rgba(255,255,255,.07)",background:"rgba(255,255,255,.01)"}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"9px 15px",border:"none",borderBottom:`2px solid ${tab===t.id?"#3b82f6":"transparent"}`,background:"transparent",color:tab===t.id?"#93c5fd":"#475569",fontSize:11,fontWeight:tab===t.id?700:400,cursor:"pointer"}}>
            {t.icon} {t.lbl}
          </button>
        ))}
        {(tab==="planning"||tab==="config")&&(
          <div style={{display:"flex",alignItems:"center",marginLeft:"auto",paddingRight:12,gap:2}}>
            {groupes.map((gg,x)=>(
              <button key={gg.id} onClick={()=>setGi(x)} style={{padding:"3px 9px",borderRadius:4,border:"none",background:gi===x?`${gg.color}22`:"transparent",color:gi===x?gg.color:"#475569",fontSize:10,fontWeight:gi===x?700:400,cursor:"pointer",borderBottom:gi===x?`2px solid ${gg.color}`:"2px solid transparent"}}>
                {gg.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── CONTENU ── */}
      <div style={{flex:1,overflow:"hidden",display:"flex"}} onClick={()=>pdfMenu&&setPdfMenu(false)}>

        {tab==="planning"&&(
          <div style={{flex:1,padding:16,overflowY:"auto"}}>
            {!g&&<div style={{background:"rgba(255,255,255,.015)",border:"1px solid rgba(255,255,255,.08)",borderRadius:10,padding:18,color:"#94a3b8",fontSize:12,textAlign:"center"}}>{serviceConfigBusy?"⏳ Chargement…":(serviceConfigMsg||"Aucun groupe disponible.")}</div>}
            {g&&<div style={{background:"rgba(255,255,255,.015)",border:`1px solid ${g.color}22`,borderRadius:10,padding:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <b style={{color:g.color,fontSize:13}}>{g.subtitle} — {mn.toUpperCase()} {year}</b>
                {g.hasEquipe&&<label style={{fontSize:10,color:"#64748b",display:"flex",gap:5,cursor:"pointer",alignItems:"center"}}>
                  <input type="checkbox" checked={autoMode} onChange={e=>setAutoMode(e.target.checked)} style={{accentColor:"#ef4444"}}/>Gardes auto
                </label>}
              </div>
              <div style={{overflowX:"auto"}}>
                <table style={{borderCollapse:"collapse",fontSize:10,tableLayout:"fixed"}}>
                  <thead><tr>
                    <th style={{...PTH,width:120,textAlign:"left",padding:"3px 6px"}}>Nom</th>
                    <th style={{...PTH,width:84,textAlign:"left",padding:"3px 3px"}}>Grade</th>
                    {g.hasEquipe&&<th style={{...PTH,width:22,color:g.color}}>Éq</th>}
                    {Array.from({length:days},(_,i)=>{
                      const d=i+1,dw=getDow(year,month,d),we=isWE(dw),ferie=isFerie(month,d);
                      return <th key={d} style={{...PTH,width:21,padding:"2px 0",background:ferie?"#001a1a":we?"#1a0800":"#0c1625",color:ferie?"#06b6d4":we?"#f97316":"#475569",fontSize:8}}>{d}<br/><span style={{fontSize:7}}>{JOURS_FR[dw].slice(0,2)}</span></th>;
                    })}
                  </tr></thead>
                  <tbody>
                    {g.membres.map((m,mi)=>(
                      <tr key={m.id||mi} style={{borderBottom:"1px solid rgba(255,255,255,.03)"}}>
                        <td style={{...PTD,padding:"2px 6px",fontWeight:600,color:"#e2e8f0"}}>{m.nom}</td>
                        <td style={{...PTD,padding:"2px 3px",color:"#64748b",fontSize:9}}>{m.grade}</td>
                        {g.hasEquipe&&<td style={{...PTD,textAlign:"center",color:g.color,fontWeight:700,fontSize:10}}>{m.equipe}</td>}
                        {Array.from({length:days},(_,i)=>{
                          const d=i+1,dw=getDow(year,month,d),we=isWE(dw),code=conges[ck(g.id,mi,d)]||"",ci=leaveTypes.find(c=>c.code===code),isAuto=autoMode&&g.hasEquipe&&code==="G",ferie=isFerie(month,d);
                          return <td key={d}
                            onClick={() => {
                              setLeaveModal({ gid: g.id, mi, name: m.nom, day: d });
                              setLmStart(d);
                              setLmEnd(d);
                              setLmType(code || "C");
                            }}
                            style={{...PTD,width:21,padding:0,background:ferie?"rgba(0,40,40,.5)":we?"rgba(40,12,0,.5)":isAuto?"rgba(239,68,68,.05)":"transparent",cursor:"pointer"}}>
                            <input value={code} maxLength={3} readOnly
                              style={{width:21,height:20,border:"none",background:"transparent",textAlign:"center",fontSize:9,fontWeight:700,outline:"none",color:ci?ci.color:ferie?"#06b6d4":we?"#2d1a0a":"#334155",fontStyle:isAuto?"italic":"normal",pointerEvents:"none"}}/>
                          </td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{marginTop:8,display:"flex",gap:8,flexWrap:"wrap",fontSize:9}}>
                {leaveTypes.map(c=><span key={c.id}><b style={{color:c.color}}>{c.code}</b><span style={{color:"#475569"}}> {c.label}</span></span>)}
                <span style={{color:"#475569"}}>· <b style={{color:"#06b6d4"}}>Cyan</b> = Jour Férié · <b style={{color:"#f97316"}}>Orange</b> = Weekend (Ven/Sam)</span>
              </div>
            </div>}
          </div>
        )}

        {tab==="feries"&&(
          <div style={{flex:1,padding:20,overflowY:"auto"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <b style={{fontSize:16,color:"#06b6d4"}}>📅 Jours Fériés Personnalisés</b>
              <button onClick={applyHolidaysToPlanning} style={{...BTN,background:"rgba(6,182,212,.15)",color:"#06b6d4"}}>⚡ Appliquer au planning actuel</button>
            </div>

            <div style={{background:"rgba(255,255,255,.02)",border:"1px solid rgba(255,255,255,.08)",borderRadius:12,padding:16,marginBottom:20}}>
              <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
                <div style={{width:60}}>
                  <div style={{fontSize:11,color:"#64748b",marginBottom:5}}>Jour</div>
                  <input type="number" min={1} max={31} value={hDay} onChange={e=>setHDay(+e.target.value)} style={INP}/>
                </div>
                <div style={{width:140}}>
                  <div style={{fontSize:11,color:"#64748b",marginBottom:5}}>Mois</div>
                  <select value={hMonth} onChange={e=>setHMonth(+e.target.value)} style={SEL}>
                    {MOIS_FR.map((m,i)=><option key={i} value={i+1}>{m}</option>)}
                  </select>
                </div>
                <div style={{flex:1,minWidth:180}}>
                  <div style={{fontSize:11,color:"#64748b",marginBottom:5}}>Label (ex: Fête locale)</div>
                  <input value={hLabel} onChange={e=>setHLabel(e.target.value)} placeholder="Nom du jour férié" style={INP}/>
                </div>
                <button onClick={addHoliday} disabled={hBusy} style={{...BTN,background:"linear-gradient(135deg,#0891b2,#06b6d4)",height:31}}>+ Ajouter</button>
              </div>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:12}}>
              {/* Fériés Fixes */}
              {FERIES_ALGERIE.map((f,i)=>(
                <div key={`fixed-${i}`} style={{background:"rgba(255,255,255,.01)",border:"1px solid rgba(255,255,255,.04)",borderRadius:10,padding:12,display:"flex",alignItems:"center",gap:12,opacity:0.6}}>
                  <div style={{width:45,textAlign:"center"}}>
                    <div style={{fontSize:16,fontWeight:800,color:"#475569"}}>{f.j}</div>
                    <div style={{fontSize:9,color:"#475569",textTransform:"uppercase"}}>{MOIS_FR[f.m-1].slice(0,3)}</div>
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:600,color:"#64748b"}}>Férié National</div>
                    <div style={{fontSize:10,color:"#334155"}}>Fixe (Algérie)</div>
                  </div>
                  <div style={{fontSize:10,color:"#334155",padding:"4px 8px",borderRadius:6,background:"rgba(255,255,255,.03)"}}>🔒</div>
                </div>
              ))}
              {/* Fériés Custom */}
              {serviceHolidays.map(h=>(
                <div key={h.id} style={{background:"rgba(6,182,212,.05)",border:"1px solid rgba(6,182,212,.2)",borderRadius:10,padding:12,display:"flex",alignItems:"center",gap:12}}>
                  <div style={{width:45,textAlign:"center"}}>
                    <div style={{fontSize:18,fontWeight:800,color:"#06b6d4"}}>{h.jour}</div>
                    <div style={{fontSize:10,color:"#06b6d4",textTransform:"uppercase",fontWeight:700}}>{MOIS_FR[h.mois-1].slice(0,3)}</div>
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:700,color:"#f8fafc"}}>{h.label}</div>
                    <div style={{fontSize:10,color:"#0891b2"}}>Personnel</div>
                  </div>
                  <button onClick={()=>delHoliday(h.id)} style={{background:"rgba(239,68,68,.1)",border:"none",color:"#ef4444",borderRadius:6,padding:"5px 8px",cursor:"pointer"}}>✕</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab==="gardes"&&(
          <div style={{flex:1,padding:20,overflowY:"auto"}}>
            <div style={{background:"rgba(239,68,68,.06)",border:"1px solid rgba(239,68,68,.2)",borderRadius:10,padding:14,marginBottom:14,fontSize:12,color:"#94a3b8",lineHeight:1.8}}>
              🔄 Ce mois de <b style={{color:"#f8fafc"}}>{mn} {year}</b>, l'équipe <b style={{color:"#ef4444",fontSize:16}}>{eqDebut}</b> commence le 1er.<br/>
              Glissez-déposez pour modifier l'ordre de rotation. Cliquez sur une équipe pour la définir comme équipe de début.
            </div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:20}}>
              {ordre.map((eq,i)=>(
                <div key={eq} 
                  onClick={() => { setComputedEqDebut(eq); setSaveMsg("⚠️ Équipe de début modifiée (n'oubliez pas de sauvegarder)"); }}
                  draggable onDragStart={()=>setDragEq(eq)} onDragOver={e=>e.preventDefault()} onDrop={()=>dropEq(eq)}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"12px 20px",borderRadius:10,cursor:"pointer",userSelect:"none",background:eq===eqDebut?"rgba(239,68,68,.18)":"rgba(255,255,255,.05)",border:`2px solid ${eq===eqDebut?"#ef4444":"rgba(255,255,255,.12)"}`,boxShadow:dragEq===eq?"0 0 0 3px #ef444444":"none"}}>
                  <span style={{fontSize:11,color:"#475569"}}>#{i+1}</span>
                  <span style={{fontSize:22,fontWeight:800,color:eq===eqDebut?"#ef4444":"#e2e8f0"}}>Équipe {eq}</span>
                  {eq===eqDebut&&<span style={{fontSize:9,color:"#ef4444",background:"rgba(239,68,68,.15)",padding:"2px 7px",borderRadius:8}}>début</span>}
                  <span style={{color:"#334155",fontSize:16}}>⠿</span>
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:10,marginBottom:20}}>
              <button onClick={()=>setOrdre(DEFAULT_ROTATION_ORDER)} style={{...BTN,background:"rgba(255,255,255,.05)",color:"#64748b"}}>↺ Reset A→B→C→D</button>
              <button onClick={()=>save()} disabled={saving} style={{...BTN,background:"linear-gradient(135deg,#1d4ed8,#0891b2)"}}>
                {saving?"⏳ Sauvegarde…":"💾 Enregistrer la Rotation"}
              </button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:8}}>
              {Array.from({length:12},(_,i)=>{ 
                const m2=(month+i-1)%12+1,y2=year+Math.floor((month+i-1)/12);
                // On projette à partir de la sélection actuelle pour voir l'impact
                const eq = calculateNextEquipeDebut(year, month, eqDebut, y2, m2, ordre);
                const cur=m2===month&&y2===year;
                return <div key={i} style={{background:cur?"rgba(239,68,68,.09)":"rgba(255,255,255,.02)",border:`1px solid ${cur?"rgba(239,68,68,.3)":"rgba(255,255,255,.06)"}`,borderRadius:8,padding:"9px 12px"}}>
                  <div style={{fontSize:11,color:cur?"#fca5a5":"#64748b",fontWeight:cur?700:400}}>{MOIS_FR[m2-1].slice(0,4)}. {y2}</div>
                  <div style={{marginTop:4,display:"flex",gap:3}}>
                    {ordre.map(e=><span key={e} style={{fontSize:10,padding:"1px 5px",borderRadius:3,background:e===eq?"rgba(239,68,68,.2)":"rgba(255,255,255,.03)",color:e===eq?"#ef4444":"#475569",fontWeight:e===eq?700:400}}>{e}{e===eq?"🚦":""}</span>)}
                  </div>
                </div>;
              })}
            </div>
          </div>
        )}

        {tab==="historique"&&(
          <div style={{flex:1,padding:20,overflowY:"auto"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <b style={{fontSize:16,color:"#94a3b8"}}>🕓 Historique des Plannings</b>
              <button onClick={loadHisto} disabled={histoBusy} style={{...BTN,background:"rgba(255,255,255,.05)"}}>↻ Rafraîchir</button>
            </div>
            {histoBusy ? <div style={{color:"#475569"}}>Chargement de l'historique…</div> : 
              <HistoList histo={histo} onLoad={loadPlan} onDelete={delPlan} groupMetaById={groupMetaById} />
            }
          </div>
        )}

        {tab==="config"&&(
          <div style={{flex:1,padding:18,overflowY:"auto"}}>
            {!g&&<div style={{background:"rgba(255,255,255,.02)",border:"1px solid rgba(255,255,255,.08)",borderRadius:9,padding:18,color:"#94a3b8",fontSize:12,textAlign:"center"}}>{serviceConfigBusy?"⏳ Chargement…":(serviceConfigMsg||"Aucun groupe disponible.")}</div>}
            {g&&<div style={{background:"rgba(255,255,255,.02)",border:`1px solid ${g.color}20`,borderRadius:9,padding:16}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:12}}>
                <div style={{fontSize:12,fontWeight:700,color:g.color,textTransform:"uppercase"}}>{g.label}</div>
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                  <button onClick={resetGroups} disabled={serviceConfigBusy||personnelSaving} style={{...BTN,background:"rgba(239,68,68,.1)",color:"#f87171",fontSize:11}} title="Réorganiser avec la nouvelle structure standard (Supprime et recrée les groupes)">⚠️ Restructurer</button>
                  <button onClick={()=>loadServiceConfig(service.id,{seedIfEmpty:false})} disabled={serviceConfigBusy||personnelSaving} style={{...BTN,background:"rgba(255,255,255,.05)",color:"#cbd5e1",fontSize:11,opacity:(serviceConfigBusy||personnelSaving)?0.7:1}}>↻ Recharger</button>
                  <button onClick={savePersonnelConfig} disabled={serviceConfigBusy||personnelSaving} style={{...BTN,background:`linear-gradient(135deg,${g.color},#0891b2)`,fontSize:11,opacity:(serviceConfigBusy||personnelSaving)?0.7:1}}>{personnelSaving?"⏳…":"Sauver le personnel"}</button>
                </div>
              </div>
              {serviceConfigMsg&&<div style={{marginBottom:12,padding:"8px 10px",borderRadius:8,background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.06)",fontSize:11,color:"#cbd5e1"}}>{serviceConfigMsg}</div>}
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr style={{background:"rgba(255,255,255,.04)"}}>
                  <th style={TH}>N°</th><th style={TH}>Nom</th><th style={TH}>Grade</th>{g.hasEquipe&&<th style={{...TH,width:65}}>Éq.</th>}<th style={{...TH,width:36}}></th>
                </tr></thead>
                <tbody>
                  {g.membres.map((m,mi)=>(
                    <tr key={m.id||mi} style={{borderBottom:"1px solid rgba(255,255,255,.04)"}}>
                      <td style={{...TD,color:"#475569",textAlign:"center",width:32}}>{mi+1}</td>
                      <td style={TD}><input value={m.nom} onChange={e=>updM(gi,mi,"nom",e.target.value)} style={{...INP,width:"100%"}}/></td>
                      <td style={TD}><input value={m.grade} onChange={e=>updM(gi,mi,"grade",e.target.value)} style={{...INP,width:"100%"}}/></td>
                      {g.hasEquipe&&<td style={TD}><select value={m.equipe||"A"} onChange={e=>updM(gi,mi,"equipe",e.target.value)} style={{...SEL,width:54}}>{ordre.map(q=><option key={q}>{q}</option>)}</select></td>}
                      <td style={{...TD,textAlign:"center"}}>
                        <div style={{display:"flex",gap:4,justifyContent:"center"}}>
                          <select onChange={e=>moveM(gi,mi,e.target.value)} value="" style={{...SEL,width:32,padding:2,fontSize:10}} title="Déplacer vers groupe...">
                            <option value="" disabled>↪️</option>
                            {groupes.map(gg=>gg.id!==g.id&&<option key={gg.id} value={gg.id}>{gg.label}</option>)}
                          </select>
                          <button onClick={()=>delM(gi,mi)} style={{background:"rgba(239,68,68,.12)",border:"none",color:"#f87171",borderRadius:4,padding:"2px 6px",cursor:"pointer"}}>✕</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button onClick={()=>addM(gi)} disabled={serviceConfigBusy||personnelSaving} style={{marginTop:10,...BTN,background:"transparent",border:`1px dashed ${g.color}44`,color:g.color,fontSize:11,opacity:(serviceConfigBusy||personnelSaving)?0.7:1}}>+ Ajouter</button>
            </div>}
          </div>
        )}

        {tab==="types_conges"&&(
          <div style={{flex:1,padding:20,overflowY:"auto"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <b style={{fontSize:16,color:"#93c5fd"}}>🏖️ Types de Congés & Activités</b>
              <div style={{fontSize:11,color:"#475569"}}>Personnalisez les codes affichés dans le planning</div>
            </div>

            <div style={{background:"rgba(255,255,255,.02)",border:"1px solid rgba(255,255,255,.08)",borderRadius:12,padding:16,marginBottom:20}}>
              <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
                <div style={{flex:1,minWidth:120}}>
                  <div style={{fontSize:11,color:"#64748b",marginBottom:5}}>Code (ex: G)</div>
                  <input value={ltForm.code} onChange={e=>setLtForm({...ltForm,code:e.target.value.toUpperCase()})} placeholder="G" style={INP}/>
                </div>
                <div style={{flex:2,minWidth:180}}>
                  <div style={{fontSize:11,color:"#64748b",marginBottom:5}}>Libellé (ex: Garde)</div>
                  <input value={ltForm.label} onChange={e=>setLtForm({...ltForm,label:e.target.value})} placeholder="Garde de nuit" style={INP}/>
                </div>
                <div style={{width:80}}>
                  <div style={{fontSize:11,color:"#64748b",marginBottom:5}}>Couleur</div>
                  <input type="color" value={ltForm.color} onChange={e=>setLtForm({...ltForm,color:e.target.value})} style={{...INP,padding:2,height:31}}/>
                </div>
                <button onClick={addLeaveType} disabled={ltBusy} style={{...BTN,background:"linear-gradient(135deg,#2563eb,#0891b2)",height:31}}>+ Ajouter</button>
              </div>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(250px,1fr))",gap:12}}>
              {leaveTypes.map(t=>(
                <div key={t.id} style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.07)",borderRadius:10,padding:12,display:"flex",alignItems:"center",gap:12}}>
                  <div style={{width:40,height:40,borderRadius:8,background:`${t.color}22`,border:`2px solid ${t.color}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:800,color:t.color}}>
                    {t.code}
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:700,color:"#f8fafc"}}>{t.label}</div>
                    <div style={{fontSize:10,color:"#475569",fontFamily:"monospace"}}>{t.color}</div>
                  </div>
                  {!t.is_default && (
                    <button onClick={()=>delLeaveType(t.id)} style={{background:"rgba(239,68,68,.1)",border:"none",color:"#ef4444",borderRadius:6,padding:"5px 8px",cursor:"pointer"}}>✕</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab==="chat"&&(
          <div style={{flex:1,display:"flex",flexDirection:"column",padding:16}}>
            <div style={{marginBottom:12,background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.08)",borderRadius:10,padding:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:10}}>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:"#93c5fd"}}>Clé API Groq <span style={{fontSize:9,color:"#475569",fontWeight:400}}>· Gratuit · {CHAT_MODEL}</span></div>
                  <div style={{fontSize:10,color:"#475569",marginTop:2}}>
                    {chatReady ? `Configurée · ${chatKeyPreview(effectiveChatApiKey)}` : "Aucune clé configurée"}
                    {effectiveChatApiKeySource==="supabase" ? " · Supabase" : effectiveChatApiKeySource==="env" ? " · .env" : ""}
                  </div>
                </div>
                <div style={{padding:"5px 10px",borderRadius:999,border:`1px solid ${chatStatusTone.border}`,background:chatStatusTone.bg,color:chatStatusTone.color,fontSize:10,fontWeight:700}}>
                  {chatReady ? "● Clé active" : "● Clé requise"}
                </div>
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                <div style={{flex:"1 1 320px",display:"flex",gap:6}}>
                  <input type={showChatApiKey?"text":"password"} value={chatApiKeyInput} onChange={e=>setChatApiKeyInput(e.target.value)} placeholder="gsk_..." style={{...INP,flex:1,padding:"9px 11px",fontFamily:"monospace"}}/>
                  <button onClick={()=>setShowChatApiKey(v=>!v)} style={{...BTN,background:"rgba(255,255,255,.05)",color:"#cbd5e1",padding:"0 10px"}}>{showChatApiKey?"Masquer":"Afficher"}</button>
                </div>
                <button onClick={saveChatApiKey} disabled={chatApiKeyBusy} style={{...BTN,background:"linear-gradient(135deg,#2563eb,#0891b2)",fontSize:11}}>{chatApiKeyBusy?"⏳…":"Sauver"}</button>
                <button onClick={clearChatApiKey} disabled={chatApiKeyBusy&&!chatReady} style={{...BTN,background:"rgba(239,68,68,.12)",color:"#fca5a5",fontSize:12,padding:"6px 10px"}} title="Effacer la clé">✕</button>
                <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" style={{fontSize:11,color:"#60a5fa",textDecoration:"none"}}>Obtenir une clé Groq gratuite</a>
              </div>
              {chatApiKeyMsg&&<div style={{marginTop:10,padding:"8px 10px",borderRadius:8,background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.06)",fontSize:11,color:"#cbd5e1"}}>{chatApiKeyMsg}</div>}
            </div>

            <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:10,paddingBottom:10}}>
              {msgs.map((m,i)=>(
                <div key={i} style={{display:"flex",justifyContent:m.r==="u"?"flex-end":"flex-start"}}>
                  <div style={{maxWidth:"80%",background:m.r==="u"?"linear-gradient(135deg,#1d4ed8,#0891b2)":"rgba(255,255,255,.04)",border:m.r==="a"?"1px solid rgba(255,255,255,.07)":"none",borderRadius:m.r==="u"?"12px 12px 2px 12px":"12px 12px 12px 2px",padding:"9px 13px",fontSize:12,lineHeight:1.7,color:m.r==="u"?"white":"#e2e8f0",whiteSpace:"pre-wrap"}}>
                    {m.r==="a"&&<span style={{marginRight:5}}>🏥</span>}{m.t}
                  </div>
                </div>
              ))}
              {chatBusy&&<div style={{color:"#475569",fontSize:11,display:"flex",gap:6}}><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>⟳</span>Groq analyse…</div>}
              <div ref={chatEnd}/>
            </div>
            <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:7}}>
              {["BOUZIANE en congé du 5 au 12","HAMDI en récup le 20","Qui est en garde le 15 ?","KASSAB maladie du 3 au 7"].map(s=>(
                <button key={s} onClick={()=>setChatIn(s)} style={{padding:"3px 8px",borderRadius:5,border:"1px solid rgba(59,130,246,.25)",background:"rgba(59,130,246,.07)",color:"#60a5fa",fontSize:10,cursor:"pointer"}}>{s}</button>
              ))}
            </div>
            <div style={{display:"flex",gap:7,background:"rgba(255,255,255,.02)",border:"1px solid rgba(255,255,255,.07)",borderRadius:8,padding:"7px 10px"}}>
              <input value={chatIn} onChange={e=>setChatIn(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()} disabled={!chatReady}
                placeholder={chatReady?"Parlez à l'agent… (ex: BOUZIANE congé du 5 au 12)":"Configurez une clé API Groq pour activer le chat"}
                style={{flex:1,background:"transparent",border:"none",color:chatReady?"#e2e8f0":"#64748b",fontSize:12,outline:"none"}}/>
              <button onClick={sendChat} disabled={!chatReady||chatBusy||!chatIn.trim()} style={{...BTN,fontSize:11,background:!chatReady||chatBusy||!chatIn.trim()?"rgba(255,255,255,.04)":"linear-gradient(135deg,#1d4ed8,#0891b2)",color:!chatReady||chatBusy||!chatIn.trim()?"#475569":"white"}}>{chatBusy?"…":"↵"}</button>
            </div>
          </div>
        )}
      </div>
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-thumb{background:#1e293b;border-radius:2px}
        select option{background:#0d1526}
        
        @media (max-width: 768px) {
          .header-title { display: none; }
          .tabs-container { overflow-x: auto; white-space: nowrap; }
          .planning-table { font-size: 8px !important; }
          .planning-input { width: 18px !important; height: 18px !important; font-size: 8px !important; }
        }
      `}</style>

      {/* ── MODAL CONGÉS (CRUD Membre) ── */}
      {leaveModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:20}}>
          <div style={{background:"#0f172a",border:"1px solid rgba(255,255,255,.1)",borderRadius:16,width:"100%",maxWidth:400,padding:24,boxShadow:"0 20px 50px rgba(0,0,0,.5)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
              <div>
                <div style={{fontSize:18,fontWeight:800,color:"#f8fafc"}}>{leaveModal.name}</div>
                <div style={{fontSize:12,color:"#64748b"}}>Gérer les congés / activités</div>
              </div>
              <button onClick={()=>setLeaveModal(null)} style={{background:"transparent",border:"none",color:"#64748b",fontSize:20,cursor:"pointer"}}>✕</button>
            </div>

            <div style={{display:"flex",flexDirection:"column",gap:16}}>
              <div>
                <div style={{fontSize:11,color:"#94a3b8",marginBottom:6}}>Type d'activité</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
                  {leaveTypes.map(t=>(
                    <button key={t.id} onClick={()=>setLmType(t.code)} style={{padding:"8px 4px",borderRadius:6,border:`1px solid ${lmType===t.code?t.color:"rgba(255,255,255,.05)"}`,background:lmType===t.code?`${t.color}22`:"rgba(255,255,255,.02)",color:lmType===t.code?t.color:"#475569",fontSize:10,fontWeight:700,cursor:"pointer"}}>
                      {t.code}
                    </button>
                  ))}
                  <button onClick={()=>setLmType("")} style={{padding:"8px 4px",borderRadius:6,border:`1px solid ${lmType===""?"#64748b":"rgba(255,255,255,.05)"}`,background:lmType===""?"rgba(100,116,139,.1)":"rgba(255,255,255,.02)",color:"#64748b",fontSize:10,fontWeight:700,cursor:"pointer"}}>
                    VIDER
                  </button>
                </div>
              </div>

              <div style={{display:"flex",gap:10}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:11,color:"#94a3b8",marginBottom:6}}>Du (jour)</div>
                  <input type="number" min={1} max={days} value={lmStart} onChange={e=>setLmStart(+e.target.value)} style={{...INP,width:"100%"}}/>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:11,color:"#94a3b8",marginBottom:6}}>Au (jour)</div>
                  <input type="number" min={1} max={days} value={lmEnd} onChange={e=>setLmEnd(+e.target.value)} style={{...INP,width:"100%"}}/>
                </div>
              </div>

              <div style={{marginTop:8,display:"flex",gap:10}}>
                <button onClick={()=>setLeaveModal(null)} style={{flex:1,...BTN,background:"rgba(255,255,255,.05)",color:"#64748b"}}>Annuler</button>
                <button onClick={applyLeave} style={{flex:2,...BTN,background:"linear-gradient(135deg,#2563eb,#0891b2)"}}>Appliquer</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HistoList({ histo, onLoad, onDelete, groupMetaById }) {
  const grouped={};
  histo.forEach(r=>{ const k=`${r.annee}-${String(r.mois).padStart(2,"0")}`; if(!grouped[k])grouped[k]={annee:r.annee,mois:r.mois,rows:[]}; grouped[k].rows.push(r); });
  return <div style={{display:"flex",flexDirection:"column",gap:8}}>
    {Object.keys(grouped).sort().reverse().map(key=>{
      const {annee,mois,rows}=grouped[key];
      return <div key={key} style={{background:"rgba(255,255,255,.02)",border:"1px solid rgba(255,255,255,.07)",borderRadius:9,padding:"12px 15px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
          <b style={{fontSize:13,color:"#93c5fd"}}>📅 {MOIS_FR[mois-1].charAt(0).toUpperCase()+MOIS_FR[mois-1].slice(1)} {annee}</b>
          <div style={{display:"flex",gap:4,flex:1,flexWrap:"wrap"}}>
            {rows.map(r=>{ const gg=groupMetaById?.[r.groupe_id]; return <span key={r.id} style={{fontSize:9,padding:"1px 6px",borderRadius:3,background:`${gg?.color||"#64748b"}15`,color:gg?.color||"#64748b"}}>{gg?.label||r.groupe_id}</span>; })}
          </div>
          <button onClick={()=>onLoad(annee,mois)} style={{...BTN,fontSize:10,padding:"3px 10px",background:"rgba(59,130,246,.15)",color:"#93c5fd"}}>📂</button>
          <button onClick={()=>onDelete(annee,mois)} style={{...BTN,fontSize:10,padding:"3px 9px",background:"rgba(239,68,68,.1)",color:"#f87171"}}>🗑️</button>
        </div>
        {rows[0]?.updated_at&&<div style={{fontSize:9,color:"#334155"}}>MàJ {new Date(rows[0].updated_at).toLocaleDateString("fr-FR")}</div>}
      </div>;
    })}
  </div>;
}

const FLD={padding:"10px 12px",borderRadius:8,border:"1px solid rgba(255,255,255,.12)",background:"rgba(255,255,255,.06)",color:"white",fontSize:13,outline:"none",fontFamily:"inherit",width:"100%"};
const INP={background:"rgba(255,255,255,.05)",border:"1px solid rgba(255,255,255,.08)",borderRadius:6,color:"#e2e8f0",padding:"5px 9px",fontSize:12,outline:"none",fontFamily:"inherit"};
const SEL={...INP,cursor:"pointer"};
const BTN={padding:"6px 12px",borderRadius:6,border:"none",color:"white",fontSize:12,fontWeight:600,cursor:"pointer",background:"rgba(255,255,255,.07)",fontFamily:"inherit"};
const TH={background:"rgba(255,255,255,.04)",color:"#475569",border:"1px solid rgba(255,255,255,.07)",padding:"6px 8px",fontWeight:600,fontSize:11,textAlign:"left"};
const TD={padding:"5px 8px",border:"1px solid rgba(255,255,255,.04)"};
const PTH={background:"#0c1525",color:"#475569",border:"1px solid rgba(255,255,255,.06)",textAlign:"center",fontWeight:600,fontSize:10,padding:"3px 1px"};
const PTD={border:"1px solid rgba(255,255,255,.05)",textAlign:"center"};