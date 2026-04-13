// app.js — Logique principale de l'app Factures

import { openDB, addFacture, updateFacture, deleteFacture, getAllFactures, saveSetting, getSetting } from './db.js';
import { initGoogle, requestGoogleAuth, isAuthed, uploadFactureImage, exportToSheets } from './google.js';

// ── État global ───────────────────────────────────────────────────────────────
let state = {
  factures: [],
  view: 'accueil',           // accueil | scan | liste | rapport | reglages
  editingId: null,
  filterAnnee: new Date().getFullYear(),
  filterMois: null,
  filterTrimestre: null,
  filterCat: null,
  filterTag: null,
  sheetId: null,
  anthropicKey: null,
  googleClientId: null,
  googleAuthed: false,
  pendingImage: null,        // dataURL de la photo en cours
  pendingExtracted: null,    // données extraites par Claude
  toast: null,
};

const CATEGORIES = ['Épicerie','Restaurant / repas d\'affaires','Bureau / fournitures','Transport','Hébergement','Équipement','Abonnements','Santé','Marketing','Autre'];
const MOIS_NOMS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function boot() {
  await openDB();
  state.anthropicKey = await getSetting('anthropic_key');
  state.googleClientId = await getSetting('google_client_id');
  state.sheetId = await getSetting('sheet_id');
  state.factures = await getAllFactures();

  if (state.googleClientId) {
    await initGoogle(state.googleClientId);
  }

  window.addEventListener('google-authed', () => {
    state.googleAuthed = true;
    showToast('Google connecté');
    render();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  render();
}

// ── Router ────────────────────────────────────────────────────────────────────
function navigate(view, opts = {}) {
  state.view = view;
  Object.assign(state, opts);
  render();
  window.scrollTo(0, 0);
}

// ── Render principal ──────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  app.appendChild(renderNav());

  const views = {
    accueil: renderAccueil,
    scan: renderScan,
    liste: renderListe,
    rapport: renderRapport,
    reglages: renderReglages,
    detail: renderDetail,
  };
  const fn = views[state.view] || renderAccueil;
  app.appendChild(fn());

  if (state.toast) {
    app.appendChild(renderToast(state.toast));
  }
}

// ── Nav ───────────────────────────────────────────────────────────────────────
function renderNav() {
  const nav = el('nav', { class: 'nav' });
  const tabs = [
    { id: 'accueil', icon: iconHome(), label: 'Accueil' },
    { id: 'scan',    icon: iconScan(), label: 'Scanner' },
    { id: 'liste',   icon: iconList(), label: 'Factures' },
    { id: 'rapport', icon: iconChart(), label: 'Rapport' },
    { id: 'reglages',icon: iconGear(), label: 'Réglages' },
  ];
  tabs.forEach(t => {
    const btn = el('button', {
      class: `nav-tab ${state.view === t.id ? 'active' : ''}`,
      onclick: () => navigate(t.id)
    });
    btn.appendChild(t.icon);
    btn.appendChild(el('span', {}, t.label));
    nav.appendChild(btn);
  });
  return nav;
}

// ── Vue Accueil ───────────────────────────────────────────────────────────────
function renderAccueil() {
  const wrap = el('div', { class: 'view-wrap' });

  const now = new Date();
  const moisFactures = state.factures.filter(f => {
    const d = new Date(f.date);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });

  const totalTPS = moisFactures.reduce((s, f) => s + (parseFloat(f.tps) || 0), 0);
  const totalTVQ = moisFactures.reduce((s, f) => s + (parseFloat(f.tvq) || 0), 0);
  const totalDep = moisFactures.reduce((s, f) => s + (parseFloat(f.total) || 0), 0);

  wrap.innerHTML = `
    <div class="page-header">
      <h1>Mes Factures</h1>
      <p class="muted">${MOIS_NOMS[now.getMonth()]} ${now.getFullYear()}</p>
    </div>

    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Dépenses</div>
        <div class="metric-val">${fmt$(totalDep)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">TPS récup.</div>
        <div class="metric-val accent">${fmt$(totalTPS)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">TVQ récup.</div>
        <div class="metric-val accent">${fmt$(totalTVQ)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Factures</div>
        <div class="metric-val">${moisFactures.length}</div>
      </div>
    </div>

    <button class="btn-primary btn-big" id="btn-scan">
      ${iconScanBig().outerHTML}
      Scanner une facture
    </button>

    <div class="section-title">Récentes</div>
  `;

  const recent = state.factures.slice(0, 5);
  if (recent.length === 0) {
    wrap.appendChild(el('p', { class: 'empty-state' }, 'Aucune facture pour l\'instant. Commencez par scanner !'));
  } else {
    const list = el('div', { class: 'facture-list' });
    recent.forEach(f => list.appendChild(renderFactureCard(f)));
    wrap.appendChild(list);
  }

  wrap.querySelector('#btn-scan').onclick = () => navigate('scan');
  return wrap;
}

// ── Vue Scan ──────────────────────────────────────────────────────────────────
function renderScan() {
  const wrap = el('div', { class: 'view-wrap' });

  if (!state.anthropicKey) {
    wrap.innerHTML = `
      <div class="page-header"><h1>Scanner</h1></div>
      <div class="alert alert-warn">
        <strong>Clé API manquante</strong><br>
        Configurez votre clé API Anthropic dans les réglages pour utiliser la lecture automatique.
      </div>
    `;
    const btn = el('button', { class: 'btn-secondary', onclick: () => navigate('reglages') }, 'Aller aux réglages');
    wrap.appendChild(btn);
    return wrap;
  }

  if (state.pendingExtracted) {
    return renderScanForm(wrap);
  }

  wrap.innerHTML = `
    <div class="page-header"><h1>Scanner une facture</h1></div>
    <div class="scan-zone" id="scan-zone">
      <input type="file" id="file-input-camera" accept="image/*" capture="environment" style="display:none">
      <input type="file" id="file-input-gallery" accept="image/*" style="display:none">
      <input type="file" id="file-input-pdf" accept="application/pdf,image/*" style="display:none">
      ${iconCamera().outerHTML}
      <p>Prenez une photo ou sélectionnez un fichier</p>
      <div class="scan-btns">
        <button class="btn-primary" id="btn-camera">📷 Appareil photo</button>
        <button class="btn-secondary" id="btn-gallery">🖼 Galerie</button>
      </div>
      <div class="scan-btns" style="margin-top:8px">
        <button class="btn-secondary" id="btn-pdf" style="width:100%">📄 Fichier PDF</button>
      </div>
    </div>
    <div id="scan-preview" style="display:none">
      <img id="preview-img" class="preview-img">
      <div class="scan-btns" style="margin-top:1rem">
        <button class="btn-primary" id="btn-extract">✨ Extraire les données</button>
        <button class="btn-ghost" id="btn-retry">Reprendre</button>
      </div>
      <div id="extract-status"></div>
    </div>
  `;

  const fileInputCamera = wrap.querySelector('#file-input-camera');
  const fileInputGallery = wrap.querySelector('#file-input-gallery');
  const fileInputPdf = wrap.querySelector('#file-input-pdf');
  const preview = wrap.querySelector('#scan-preview');
  const scanZone = wrap.querySelector('#scan-zone');
  const previewImg = wrap.querySelector('#preview-img');

  const showPreview = (dataUrl) => {
    state.pendingImage = dataUrl;
    previewImg.src = dataUrl;
    scanZone.style.display = 'none';
    preview.style.display = 'block';
  };

  const handleImageFile = (file) => {
    const reader = new FileReader();
    reader.onload = e => showPreview(e.target.result);
    reader.readAsDataURL(file);
  };

  const handlePdfFile = async (file) => {
    // Render first page of PDF to canvas using PDF.js
    const status = wrap.querySelector('#extract-status') || document.createElement('div');
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdfjsLib = window['pdfjs-dist/build/pdf'];
      if (!pdfjsLib) {
        // Fallback: read as dataURL and send directly
        const reader = new FileReader();
        reader.onload = e => showPreview(e.target.result);
        reader.readAsDataURL(file);
        return;
      }
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 2.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      showPreview(canvas.toDataURL('image/jpeg', 0.92));
    } catch (err) {
      // Fallback: send PDF as-is
      const reader = new FileReader();
      reader.onload = e => showPreview(e.target.result);
      reader.readAsDataURL(file);
    }
  };

  wrap.querySelector('#btn-camera').onclick = () => fileInputCamera.click();
  wrap.querySelector('#btn-gallery').onclick = () => fileInputGallery.click();
  wrap.querySelector('#btn-pdf').onclick = () => fileInputPdf.click();

  fileInputCamera.onchange = e => { if (e.target.files[0]) handleImageFile(e.target.files[0]); };
  fileInputGallery.onchange = e => { if (e.target.files[0]) handleImageFile(e.target.files[0]); };
  fileInputPdf.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.type === 'application/pdf') {
      handlePdfFile(file);
    } else {
      handleImageFile(file);
    }
  };

  wrap.querySelector('#btn-retry').onclick = () => {
    state.pendingImage = null;
    render();
  };

  wrap.querySelector('#btn-extract').onclick = () => extractWithClaude(wrap);

  return wrap;
}

async function imageToJpegBase64(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // Redimensionne si trop grand (max 2400px sur le grand côté)
      const MAX = 3200;
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      // Qualité 0.82 — bon équilibre lisibilité / poids
      const jpeg = canvas.toDataURL('image/jpeg', 0.82);
      resolve(jpeg);
    };
    img.src = dataUrl;
  });
}

async function extractWithClaude(wrap) {
  const status = wrap.querySelector('#extract-status');
  status.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div> Lecture en cours…</div>';
  wrap.querySelector('#btn-extract').disabled = true;

  try {
    // Convertit en JPEG si nécessaire (HEIC, PNG, etc.)
    const mimeType = state.pendingImage.split(';')[0].split(':')[1];
    const needsConversion = !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType);
    const imageData = (needsConversion || mimeType === 'image/heic' || mimeType === 'image/heif')
      ? await imageToJpegBase64(state.pendingImage)
      : state.pendingImage;

    const base64 = imageData.split(',')[1];
    const finalMime = imageData.split(';')[0].split(':')[1];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': state.anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: finalMime, data: base64 }
            },
            {
              type: 'text',
              text: `Analyse cette facture ou reçu avec une attention EXTRÊME aux chiffres. Lis les montants tels qu'ils sont imprimés, sans jamais calculer ni estimer. Extrait les informations suivantes en JSON strict (sans markdown, juste le JSON).

IMPORTANT: Si tu n'es pas certain d'un montant, mets 0 plutôt que de deviner.

RÈGLES IMPORTANTES pour TPS et TVQ:
1. Cherche les lignes explicites "TPS", "GST", "Taxe fédérale" et "TVQ", "QST", "Taxe provinciale" et utilise ces montants EXACTS.
2. Si une seule ligne "Taxes" ou "Tax" regroupe les deux, calcule: TPS = total_taxes * (5/14.975), TVQ = total_taxes * (9.975/14.975).
3. Si aucune taxe n'est indiquée (produits non taxables), mets TPS=0 et TVQ=0. Ne jamais calculer les taxes depuis le sous-total si elles ne sont pas imprimées.
4. A l'épicerie, les montants varient selon les articles taxables - lis uniquement ce qui est imprimé sur le reçu.

Champs requis:
- fournisseur: string (nom du magasin/restaurant/entreprise)
- date: string format YYYY-MM-DD
- sous_total: number (avant taxes, 0 si non visible)
- tps: number (montant TPS exact lu sur le reçu, 0 si absent)
- tvq: number (montant TVQ exact lu sur le reçu, 0 si absent)
- total: number (montant total payé)
- pourboire: number (montant du pourboire si présent sur le reçu, 0 sinon)
- categorie: string (une parmi: Épicerie, Restaurant / repas d'affaires, Bureau / fournitures, Transport, Hébergement, Équipement, Abonnements, Santé, Marketing, Autre)
- notes: string (toute info pertinente, vide si rien)

Si une valeur est illisible, mets 0 pour les nombres et "" pour les strings."`
            }
          ]
        }]
      })
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      const msg = data.error?.message || `HTTP ${response.status}`;
      throw new Error(msg);
    }

    const text = data.content?.[0]?.text || '';
    if (!text) throw new Error("Réponse vide de l'API");

    const clean = text.replace(/```json|```/g, '').trim();
    const extracted = JSON.parse(clean);
    // Corrige l'année si elle semble incorrecte (ex: 2025 au lieu de 2026)
    const currentYear = new Date().getFullYear();
    if (extracted.date) {
      const parts = extracted.date.split('-');
      if (parts[0] && parseInt(parts[0]) < currentYear) {
        parts[0] = currentYear.toString();
        extracted.date = parts.join('-');
      }
    }
    state.pendingExtracted = extracted;
    render();
  } catch (err) {
    status.innerHTML = `<div class="alert alert-error">Erreur : ${err.message}</div>`;
    wrap.querySelector('#btn-extract').disabled = false;
  }
}

function renderScanForm(wrap) {
  const f = state.pendingExtracted || {};
  const tags = (f.tags || []).join(', ');

  wrap.innerHTML = `
    <div class="page-header">
      <h1>Vérifier la facture</h1>
      <p class="muted">Corrigez si nécessaire</p>
    </div>
    ${state.pendingImage ? `<img src="${state.pendingImage}" class="preview-img-small">` : ''}
    <form id="facture-form" class="form">
      <div class="form-group">
        <label>Fournisseur</label>
        <input type="text" name="fournisseur" value="${esc(f.fournisseur || '')}" required>
      </div>
      <div class="form-group">
        <label>Date</label>
        <input type="date" name="date" value="${esc(f.date || today())}" required>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Sous-total ($)</label>
          <input type="number" name="sous_total" value="${f.sous_total || 0}" step="0.01" min="0">
        </div>
        <div class="form-group">
          <label>TPS ($)</label>
          <input type="number" name="tps" value="${f.tps || 0}" step="0.01" min="0">
        </div>
        <div class="form-group">
          <label>TVQ ($)</label>
          <input type="number" name="tvq" value="${f.tvq || 0}" step="0.01" min="0">
        </div>
      </div>
      <div class="form-group">
        <label>Total ($)</label>
        <input type="number" name="total" value="${f.total || 0}" step="0.01" min="0" required>
      </div>
      <div class="form-group">
        <label>Catégorie</label>
        <select name="categorie" id="sel-categorie">
          ${CATEGORIES.map(c => `<option value="${c}" ${c === f.categorie ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="form-group" id="pourboire-group" style="display:${f.categorie === "Restaurant / repas d'affaires" ? 'flex' : 'none'}; flex-direction:column; gap:6px">
        <label>Pourboire ($)</label>
        <input type="number" name="pourboire" value="${f.pourboire || 0}" step="0.01" min="0">
      </div>
      <div class="form-group">
        <label>Type de dépense</label>
        <select name="type_depense">
          <option value="affaires">Affaires</option>
          <option value="personnel">Personnel</option>
          <option value="mixte">Mixte</option>
        </select>
      </div>
      <div class="form-group">
        <label>Tags (séparés par des virgules)</label>
        <input type="text" name="tags" value="${esc(tags)}" placeholder="ex: client-abc, projet-x, voyage">
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea name="notes" rows="2">${esc(f.notes || '')}</textarea>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn-primary" id="btn-save">💾 Enregistrer</button>
        <button type="button" class="btn-ghost" id="btn-cancel">Annuler</button>
      </div>
    </form>
  `;

  // Show/hide pourboire based on category
  wrap.querySelector('#sel-categorie')?.addEventListener('change', e => {
    const pg = wrap.querySelector('#pourboire-group');
    if (pg) pg.style.display = e.target.value === "Restaurant / repas d'affaires" ? 'flex' : 'none';
  });

  wrap.querySelector('#btn-cancel').onclick = () => {
    state.pendingImage = null;
    state.pendingExtracted = null;
    navigate('accueil');
  };

  wrap.querySelector('#facture-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = wrap.querySelector('#btn-save');
    btn.disabled = true;
    btn.textContent = 'Enregistrement…';

    const facture = {
      fournisseur: fd.get('fournisseur'),
      date: fd.get('date'),
      sous_total: parseFloat(fd.get('sous_total')) || 0,
      tps: parseFloat(fd.get('tps')) || 0,
      tvq: parseFloat(fd.get('tvq')) || 0,
      total: parseFloat(fd.get('total')) || 0,
      categorie: fd.get('categorie'),
      type_depense: fd.get('type_depense'),
      pourboire: parseFloat(fd.get('pourboire')) || 0,
      tags: fd.get('tags').split(',').map(t => t.trim()).filter(Boolean),
      notes: fd.get('notes'),
      image: state.pendingImage || null,
      drive_url: null,
      annee_mois: fd.get('date').substring(0, 7)
    };

    // Upload Drive si connecté
    if (isAuthed() && state.pendingImage) {
      try {
        btn.textContent = '☁️ Upload Drive…';
        facture.drive_url = await uploadFactureImage(state.pendingImage, facture);
      } catch (err) {
        console.warn('Drive upload échoué:', err);
      }
    }

    await addFacture(facture);
    state.factures = await getAllFactures();
    state.pendingImage = null;
    state.pendingExtracted = null;
    showToast('Facture enregistrée !');
    navigate('liste');
  };

  return wrap;
}

// ── Vue Liste ─────────────────────────────────────────────────────────────────
function renderListe() {
  const wrap = el('div', { class: 'view-wrap' });

  const annees = [...new Set(state.factures.map(f => new Date(f.date).getFullYear()))].sort((a,b) => b-a);
  const allTags = [...new Set(state.factures.flatMap(f => f.tags || []))].sort();

  let filtered = state.factures.filter(f => {
    const d = new Date(f.date);
    if (state.filterAnnee && d.getFullYear() !== state.filterAnnee) return false;
    if (state.filterMois && (d.getMonth() + 1) !== state.filterMois) return false;
    if (state.filterCat && f.categorie !== state.filterCat) return false;
    if (state.filterTag && !(f.tags || []).includes(state.filterTag)) return false;
    return true;
  });

  wrap.innerHTML = `
    <div class="page-header"><h1>Factures</h1></div>
    <div class="filters">
      <select id="f-annee">
        <option value="">Toutes les années</option>
        ${annees.map(a => `<option value="${a}" ${state.filterAnnee === a ? 'selected' : ''}>${a}</option>`).join('')}
      </select>
      <select id="f-mois">
        <option value="">Tous les mois</option>
        ${MOIS_NOMS.map((m, i) => `<option value="${i+1}" ${state.filterMois === (i+1) ? 'selected' : ''}>${m}</option>`).join('')}
      </select>
      <select id="f-cat">
        <option value="">Toutes catégories</option>
        ${CATEGORIES.map(c => `<option value="${c}" ${state.filterCat === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
      ${allTags.length > 0 ? `
      <select id="f-tag">
        <option value="">Tous les tags</option>
        ${allTags.map(t => `<option value="${t}" ${state.filterTag === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select>` : ''}
    </div>
    <div class="liste-summary muted">${filtered.length} facture${filtered.length !== 1 ? 's' : ''} · ${fmt$(filtered.reduce((s,f) => s + (parseFloat(f.total)||0), 0))} total</div>
  `;

  wrap.querySelector('#f-annee').onchange = e => { state.filterAnnee = e.target.value ? parseInt(e.target.value) : null; render(); };
  wrap.querySelector('#f-mois').onchange = e => { state.filterMois = e.target.value ? parseInt(e.target.value) : null; render(); };
  wrap.querySelector('#f-cat').onchange = e => { state.filterCat = e.target.value || null; render(); };
  wrap.querySelector('#f-tag')?.addEventListener('change', e => { state.filterTag = e.target.value || null; render(); });

  if (filtered.length === 0) {
    wrap.appendChild(el('p', { class: 'empty-state' }, 'Aucune facture pour ces filtres.'));
  } else {
    const list = el('div', { class: 'facture-list' });
    filtered.forEach(f => list.appendChild(renderFactureCard(f)));
    wrap.appendChild(list);
  }
  return wrap;
}

function renderFactureCard(f) {
  const card = el('div', { class: 'facture-card', onclick: () => navigate('detail', { editingId: f.id }) });
  card.innerHTML = `
    <div class="fc-top">
      <span class="fc-fournisseur">${esc(f.fournisseur || '—')}</span>
      <span class="fc-total">${fmt$(f.total)}</span>
    </div>
    <div class="fc-bottom">
      <span class="fc-date muted">${fmtDate(f.date)}</span>
      <span class="fc-cat tag-chip">${esc(f.categorie || '')}</span>
    </div>
    ${f.tags?.length ? `<div class="fc-tags">${f.tags.map(t => `<span class="tag-small">${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="fc-taxes muted">TPS ${fmt$(f.tps)} · TVQ ${fmt$(f.tvq)}</div>
  `;
  return card;
}

// ── Vue Détail / Édition ──────────────────────────────────────────────────────
function renderDetail() {
  const f = state.factures.find(x => x.id === state.editingId);
  if (!f) return renderListe();
  const wrap = el('div', { class: 'view-wrap' });
  const tags = (f.tags || []).join(', ');

  wrap.innerHTML = `
    <div class="page-header">
      <button class="btn-back" id="btn-back">← Retour</button>
      <h1>Détail facture</h1>
    </div>
    ${f.image ? `<img src="${f.image}" class="preview-img-small">` : ''}
    ${f.drive_url 
      ? `<a href="${f.drive_url}" target="_blank" class="drive-link">📁 Voir dans Drive</a>` 
      : f.image 
        ? `<button class="btn-secondary" id="btn-upload-drive" style="margin-bottom:1rem">☁️ Envoyer vers Drive</button>`
        : ''
    }
    <form id="edit-form" class="form">
      <div class="form-group">
        <label>Fournisseur</label>
        <input type="text" name="fournisseur" value="${esc(f.fournisseur || '')}" required>
      </div>
      <div class="form-group">
        <label>Date</label>
        <input type="date" name="date" value="${esc(f.date || '')}">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Sous-total</label>
          <input type="number" name="sous_total" value="${f.sous_total}" step="0.01">
        </div>
        <div class="form-group">
          <label>TPS</label>
          <input type="number" name="tps" value="${f.tps}" step="0.01">
        </div>
        <div class="form-group">
          <label>TVQ</label>
          <input type="number" name="tvq" value="${f.tvq}" step="0.01">
        </div>
      </div>
      <div class="form-group">
        <label>Total</label>
        <input type="number" name="total" value="${f.total}" step="0.01" required>
      </div>
      <div class="form-group">
        <label>Catégorie</label>
        <select name="categorie">
          ${CATEGORIES.map(c => `<option value="${c}" ${c === f.categorie ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Type de dépense</label>
        <select name="type_depense">
          <option value="affaires" ${f.type_depense==='affaires'?'selected':''}>Affaires</option>
          <option value="personnel" ${f.type_depense==='personnel'?'selected':''}>Personnel</option>
          <option value="mixte" ${f.type_depense==='mixte'?'selected':''}>Mixte</option>
        </select>
      </div>
      <div class="form-group">
        <label>Tags</label>
        <input type="text" name="tags" value="${esc(tags)}">
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea name="notes" rows="2">${esc(f.notes || '')}</textarea>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn-primary">💾 Sauvegarder</button>
        <button type="button" class="btn-danger" id="btn-delete">🗑 Supprimer</button>
      </div>
    </form>
  `;

  wrap.querySelector('#btn-back').onclick = () => navigate('liste');

  wrap.querySelector('#btn-upload-drive')?.addEventListener('click', async () => {
    const btn = wrap.querySelector('#btn-upload-drive');
    if (!isAuthed()) {
      showToast('Connectez Google dans les réglages');
      return;
    }
    btn.disabled = true;
    btn.textContent = '☁️ Upload en cours…';
    try {
      // Get current form values for folder structure
      const fd = new FormData(wrap.querySelector('#edit-form'));
      const factureData = {
        date: fd.get('date') || f.date,
        categorie: fd.get('categorie') || f.categorie,
        fournisseur: fd.get('fournisseur') || f.fournisseur
      };
      const driveUrl = await uploadFactureImage(f.image, factureData);
      await updateFacture(f.id, { drive_url: driveUrl });
      state.factures = await getAllFactures();
      showToast('Photo envoyée vers Drive !');
      navigate('detail', { editingId: f.id });
    } catch (err) {
      showToast('Erreur Drive : ' + err.message);
      btn.disabled = false;
      btn.textContent = '☁️ Envoyer vers Drive';
    }
  });

  wrap.querySelector('#edit-form').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await updateFacture(f.id, {
      fournisseur: fd.get('fournisseur'),
      date: fd.get('date'),
      sous_total: parseFloat(fd.get('sous_total')) || 0,
      tps: parseFloat(fd.get('tps')) || 0,
      tvq: parseFloat(fd.get('tvq')) || 0,
      total: parseFloat(fd.get('total')) || 0,
      categorie: fd.get('categorie'),
      type_depense: fd.get('type_depense'),
      tags: fd.get('tags').split(',').map(t => t.trim()).filter(Boolean),
      notes: fd.get('notes'),
      annee_mois: fd.get('date').substring(0, 7)
    });
    state.factures = await getAllFactures();
    showToast('Facture mise à jour');
    navigate('liste');
  };

  wrap.querySelector('#btn-delete').onclick = async () => {
    if (!confirm('Supprimer cette facture ?')) return;
    await deleteFacture(f.id);
    state.factures = await getAllFactures();
    showToast('Facture supprimée');
    navigate('liste');
  };

  return wrap;
}

// ── Vue Rapport ───────────────────────────────────────────────────────────────
function renderRapport() {
  const wrap = el('div', { class: 'view-wrap' });

  const annees = [...new Set(state.factures.map(f => new Date(f.date).getFullYear()))].sort((a,b) => b-a);
  const selectedAnnee = state.filterAnnee || new Date().getFullYear();
  const selectedMois = state.filterMois;

  const TRIMESTRES = { 1: [1,2,3], 2: [4,5,6], 3: [7,8,9], 4: [10,11,12] };

  let filtered = state.factures.filter(f => {
    const d = new Date(f.date);
    if (d.getFullYear() !== selectedAnnee) return false;
    if (state.filterTrimestre && !TRIMESTRES[state.filterTrimestre].includes(d.getMonth() + 1)) return false;
    if (selectedMois && (d.getMonth() + 1) !== selectedMois) return false;
    return true;
  });

  const affaires = filtered.filter(f => f.type_depense !== 'personnel');
  const totalTPS = affaires.reduce((s, f) => s + (parseFloat(f.tps) || 0), 0);
  const totalTVQ = affaires.reduce((s, f) => s + (parseFloat(f.tvq) || 0), 0);
  const totalDep = affaires.reduce((s, f) => s + (parseFloat(f.total) || 0), 0);

  // Par catégorie
  const parCat = {};
  affaires.forEach(f => {
    const c = f.categorie || 'Autre';
    if (!parCat[c]) parCat[c] = { total: 0, tps: 0, tvq: 0, count: 0 };
    parCat[c].total += parseFloat(f.total) || 0;
    parCat[c].tps += parseFloat(f.tps) || 0;
    parCat[c].tvq += parseFloat(f.tvq) || 0;
    parCat[c].count++;
  });

  wrap.innerHTML = `
    <div class="page-header"><h1>Rapport taxes</h1></div>
    <div class="filters">
      <select id="r-annee">
        ${annees.length === 0 
          ? `<option value="${new Date().getFullYear()}" selected>${new Date().getFullYear()}</option>`
          : annees.map(a => `<option value="${a}" ${a === selectedAnnee ? 'selected' : ''}>${a}</option>`).join('')
        }
      </select>
      <select id="r-trimestre">
        <option value="" ${!state.filterTrimestre ? 'selected' : ''}>Toute l'année</option>
        <option value="1" ${state.filterTrimestre === 1 ? 'selected' : ''}>T1 — Jan · Fév · Mar</option>
        <option value="2" ${state.filterTrimestre === 2 ? 'selected' : ''}>T2 — Avr · Mai · Jun</option>
        <option value="3" ${state.filterTrimestre === 3 ? 'selected' : ''}>T3 — Jul · Aoû · Sep</option>
        <option value="4" ${state.filterTrimestre === 4 ? 'selected' : ''}>T4 — Oct · Nov · Déc</option>
      </select>
      <select id="r-mois">
        <option value="" ${!selectedMois ? 'selected' : ''}>Tous les mois</option>
        ${MOIS_NOMS.map((m, i) => `<option value="${i+1}" ${selectedMois === (i+1) ? 'selected' : ''}>${m}</option>`).join('')}
      </select>
    </div>

    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Dépenses d'affaires</div>
        <div class="metric-val">${fmt$(totalDep)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">TPS récupérable</div>
        <div class="metric-val accent">${fmt$(totalTPS)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">TVQ récupérable</div>
        <div class="metric-val accent">${fmt$(totalTVQ)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Total récupérable</div>
        <div class="metric-val accent">${fmt$(totalTPS + totalTVQ)}</div>
      </div>
    </div>

    <div class="section-title">Par catégorie</div>
    <div class="cat-table">
      <div class="cat-row cat-header">
        <span>Catégorie</span><span>Dép.</span><span>TPS</span><span>TVQ</span>
      </div>
      ${Object.entries(parCat).sort((a,b) => b[1].total - a[1].total).map(([cat, v]) => `
        <div class="cat-row">
          <span>${cat}</span>
          <span>${fmt$(v.total)}</span>
          <span>${fmt$(v.tps)}</span>
          <span>${fmt$(v.tvq)}</span>
        </div>
      `).join('')}
    </div>

    <div class="form-actions" style="margin-top:1.5rem">
      <button class="btn-primary" id="btn-export-sheets">📊 Exporter vers Google Sheets</button>
      <button class="btn-secondary" id="btn-export-csv">⬇ Télécharger CSV</button>
    </div>
    <div id="export-status"></div>
  `;

  wrap.querySelector('#r-annee').onchange = e => { state.filterAnnee = parseInt(e.target.value); render(); };
  wrap.querySelector('#r-trimestre').onchange = e => {
    state.filterTrimestre = e.target.value ? parseInt(e.target.value) : null;
    state.filterMois = null;
    render();
  };
  wrap.querySelector('#r-mois').onchange = e => {
    state.filterMois = e.target.value ? parseInt(e.target.value) : null;
    state.filterTrimestre = null;
    render();
  };

  wrap.querySelector('#btn-export-csv').onclick = () => exportCSV(filtered);

  wrap.querySelector('#btn-export-sheets').onclick = async () => {
    const status = wrap.querySelector('#export-status');
    if (!isAuthed()) {
      if (!state.googleClientId) {
        status.innerHTML = '<div class="alert alert-warn">Configurez votre Google Client ID dans les réglages.</div>';
        return;
      }
      requestGoogleAuth();
      status.innerHTML = '<div class="muted">Authentification Google en cours…</div>';
      return;
    }
    try {
      status.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div> Export en cours…</div>';
      // Réutilise le même fichier Sheets, le recrée seulement si absent
      const url = await exportToSheets(filtered, state.sheetId, state.factures);
      const id = url.split('/d/')[1].split('/')[0];
      if (!state.sheetId) {
        state.sheetId = id;
        await saveSetting('sheet_id', id);
      }
      status.innerHTML = `<div class="alert alert-ok">✅ Exporté ! <a href="${url}" target="_blank">Ouvrir le fichier</a></div>`;
    } catch (err) {
      status.innerHTML = `<div class="alert alert-error">Erreur : ${err.message}</div>`;
    }
  };

  return wrap;
}

function exportCSV(factures) {
  const header = 'Date,Fournisseur,Catégorie,Tags,Sous-total,TPS,TVQ,Total,Type,Notes\n';
  const rows = factures.map(f =>
    [f.date, f.fournisseur, f.categorie, (f.tags||[]).join('|'), f.sous_total, f.tps, f.tvq, f.total, f.type_depense, f.notes]
      .map(v => `"${String(v||'').replace(/"/g,'""')}"`)
      .join(',')
  ).join('\n');
  const blob = new Blob(['\ufeff' + header + rows], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `factures_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Vue Réglages ──────────────────────────────────────────────────────────────
function renderReglages() {
  const wrap = el('div', { class: 'view-wrap' });
  wrap.innerHTML = `
    <div class="page-header"><h1>Réglages</h1></div>

    <div class="settings-section">
      <div class="settings-label">API Anthropic (lecture de factures)</div>
      <div class="form-group">
        <label>Clé API Anthropic</label>
        <input type="password" id="s-anthropic" value="${state.anthropicKey || ''}" placeholder="sk-ant-...">
        <p class="field-hint">Disponible sur console.anthropic.com</p>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Google (Drive + Sheets)</div>
      <div class="form-group">
        <label>Google OAuth Client ID</label>
        <input type="text" id="s-google-id" value="${state.googleClientId || ''}" placeholder="xxx.apps.googleusercontent.com">
        <p class="field-hint">Créez un projet dans console.cloud.google.com</p>
      </div>
      <div class="form-group">
        <label>Google Sheets ID (optionnel)</label>
        <input type="text" id="s-sheet-id" value="${state.sheetId || ''}" placeholder="Laissez vide pour créer automatiquement">
      </div>
      <button class="btn-secondary" id="btn-google-auth" ${state.googleAuthed ? 'disabled' : ''}>
        ${state.googleAuthed ? '✅ Google connecté' : '🔗 Connecter Google'}
      </button>
    </div>

    <div class="form-actions">
      <button class="btn-primary" id="btn-save-settings">💾 Sauvegarder</button>
    </div>

    <div class="settings-section" style="margin-top:2rem">
      <div class="settings-label">À propos</div>
      <p class="muted" style="font-size:13px; line-height:1.6">
        <strong>Mes Factures</strong> — PWA v1.0<br>
        Données stockées localement sur votre appareil (IndexedDB).<br>
        Les photos ne quittent pas votre appareil sauf si vous activez Google Drive.
      </p>
    </div>
  `;

  wrap.querySelector('#btn-save-settings').onclick = async () => {
    const key = wrap.querySelector('#s-anthropic').value.trim();
    const gid = wrap.querySelector('#s-google-id').value.trim();
    const sid = wrap.querySelector('#s-sheet-id').value.trim();

    if (key) { state.anthropicKey = key; await saveSetting('anthropic_key', key); }
    if (gid) { state.googleClientId = gid; await saveSetting('google_client_id', gid); }
    if (sid) { state.sheetId = sid; await saveSetting('sheet_id', sid); }

    if (gid) await initGoogle(gid);
    showToast('Réglages sauvegardés');
    render();
  };

  wrap.querySelector('#btn-google-auth')?.addEventListener('click', () => {
    if (!state.googleClientId) {
      showToast('Entrez d\'abord votre Google Client ID');
      return;
    }
    requestGoogleAuth();
  });

  return wrap;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg) {
  state.toast = msg;
  render();
  setTimeout(() => { state.toast = null; render(); }, 2800);
}

function renderToast(msg) {
  const t = el('div', { class: 'toast' }, msg);
  return t;
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function el(tag, attrs = {}, text = null) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e[k] = v;
    else e.setAttribute(k, v);
  });
  if (text !== null) e.textContent = text;
  return e;
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmt$(n) {
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(parseFloat(n) || 0);
}

function fmtDate(str) {
  if (!str) return '—';
  const d = new Date(str + 'T12:00:00');
  return d.toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────
function svgIcon(path, size = 22) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = path;
  return s;
}
function iconHome()  { return svgIcon('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'); }
function iconScan()  { return svgIcon('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h.01M18 14h.01M14 18h.01M18 18h.01"/>'); }
function iconList()  { return svgIcon('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>'); }
function iconChart() { return svgIcon('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/>'); }
function iconGear()  { return svgIcon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'); }
function iconCamera(){ return svgIcon('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>', 48); }
function iconScanBig(){ return svgIcon('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h.01M18 14h.01M14 18h.01M18 18h.01"/>', 20); }

// ── Boot ──────────────────────────────────────────────────────────────────────
boot();
