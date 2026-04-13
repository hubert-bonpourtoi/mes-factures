// google.js — Google Drive + Sheets integration via OAuth2

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets'
].join(' ');

let tokenClient = null;
let accessToken = null;

// ── Init Google Identity Services ────────────────────────────────────────────
export function initGoogle(clientId) {
  return new Promise((resolve) => {
    if (!window.google) { resolve(false); return; }
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.access_token) {
          accessToken = resp.access_token;
          window.dispatchEvent(new CustomEvent('google-authed'));
        }
      }
    });
    resolve(true);
  });
}

export function requestGoogleAuth() {
  if (!tokenClient) return;
  tokenClient.requestAccessToken();
}

export function isAuthed() { return !!accessToken; }

// ── Drive helpers ─────────────────────────────────────────────────────────────
async function driveRequest(path, options = {}) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  });
  if (!res.ok) throw new Error(`Drive error: ${res.status}`);
  return res.json();
}

async function driveUploadRequest(metadata, blob) {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` },
    body: form
  });
  if (!res.ok) throw new Error(`Drive upload error: ${res.status}`);
  return res.json();
}

async function findOrCreateFolder(name, parentId = null) {
  // Escape single quotes in name for Drive query (replace ' with \')
  const safeName = name.replace(/'/g, "\\'");
  const q = [`name='${safeName}'`, `mimeType='application/vnd.google-apps.folder'`, `trashed=false`];
  if (parentId) q.push(`'${parentId}' in parents`);
  const { files } = await driveRequest(`files?q=${encodeURIComponent(q.join(' and '))}&fields=files(id,name)`);
  if (files.length > 0) return files[0].id;
  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];
  const { id } = await driveRequest('files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return id;
}

// ── Upload facture image to Drive ─────────────────────────────────────────────
// Structure: Factures / 2025 / 04 - Avril / Épicerie /
export async function uploadFactureImage(imageDataUrl, facture) {
  if (!accessToken) throw new Error('Non authentifié Google');

  const date = new Date(facture.date);
  const annee = date.getFullYear().toString();
  const moisNum = String(date.getMonth() + 1).padStart(2, '0');
  const moisNoms = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const moisNom = moisNoms[date.getMonth()];
  const moisLabel = `${moisNum} - ${moisNom}`;
  // Nettoie le nom de catégorie pour Drive (remplace / par -)
  const categorie = (facture.categorie || 'Autre').replace(/\s*\/\s*/g, ' - ');

  const rootId = await findOrCreateFolder('Factures');
  const anneeId = await findOrCreateFolder(annee, rootId);
  const moisId = await findOrCreateFolder(moisLabel, anneeId);
  const catId = await findOrCreateFolder(categorie, moisId);

  // Convert dataURL to blob
  const res = await fetch(imageDataUrl);
  const blob = await res.blob();
  const ext = blob.type.includes('pdf') ? 'pdf' : 'jpg';
  const fileName = `${facture.fournisseur || 'facture'}_${facture.date}.${ext}`.replace(/[^a-z0-9._-]/gi, '_');

  const uploaded = await driveUploadRequest(
    { name: fileName, parents: [catId] },
    blob
  );
  return `https://drive.google.com/file/d/${uploaded.id}/view`;
}

// ── Google Sheets export ──────────────────────────────────────────────────────
export async function exportToSheets(factures, sheetId = null) {
  if (!accessToken) throw new Error('Non authentifié Google');

  let id = sheetId;
  const annee = new Date().getFullYear();

  if (!id) {
    // Create new spreadsheet with 2 sheets
    const { spreadsheetId } = await sheetsRequest('', {
      method: 'POST',
      body: JSON.stringify({
        properties: { title: `Factures BPT ${annee}` },
        sheets: [
          { properties: { title: 'Factures', sheetId: 0 } },
          { properties: { title: 'Réconciliation', sheetId: 1 } }
        ]
      })
    }, true);
    id = spreadsheetId;
  }

  // ── Onglet 1 : Factures (même structure que Excel) ───────────────────────
  const headerF = [['Date','Fournisseur','Montant total','S-Total','TPS réelle','TVQ réelle','Pourboire','Catégorie','Type dépense','Tags','Notes','Lien Drive']];
  const rowsF = factures.map(f => [
    f.date || '',
    f.fournisseur || '',
    f.total || 0,
    f.sous_total || 0,
    f.tps || 0,
    f.tvq || 0,
    f.pourboire || 0,
    f.categorie || '',
    f.type_depense || '',
    (f.tags || []).join(', '),
    f.notes || '',
    f.drive_url || ''
  ]);

  await sheetsRequest(`/${id}/values/Factures!A1:L${1 + rowsF.length}:clear`, { method: 'POST' });
  await sheetsRequest(`/${id}/values/Factures!A1:L${1 + rowsF.length}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: [...headerF, ...rowsF] })
  });

  // ── Onglet 2 : Réconciliation ─────────────────────────────────────────────
  const headerR = [['Montant relevé CC','Fournisseur facture','Date facture','TPS réelle','TVQ réelle','Pourboire','Catégorie','Drive','Réconcilié ?','Notes']];
  const rowsR = factures.map(f => [
    f.total || 0,
    f.fournisseur || '',
    f.date || '',
    f.tps || 0,
    f.tvq || 0,
    f.pourboire || 0,
    f.categorie || '',
    f.drive_url ? `=HYPERLINK("${f.drive_url}","📄 Voir")` : '',
    '☐',
    f.notes || ''
  ]);

  // Sort by total amount for easier lookup
  rowsR.sort((a, b) => b[0] - a[0]);

  await sheetsRequest(`/${id}/values/R%C3%A9conciliation!A1:J${1 + rowsR.length}:clear`, { method: 'POST' });
  await sheetsRequest(`/${id}/values/R%C3%A9conciliation!A1:J${1 + rowsR.length}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values: [...headerR, ...rowsR] })
  });

  // ── Formatage des deux onglets ─────────────────────────────────────────────
  await sheetsRequest(`/${id}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        // En-tête Factures — fond foncé, texte blanc, gras
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              backgroundColor: { red: 0.06, green: 0.06, blue: 0.06 }
            }},
            fields: 'userEnteredFormat(textFormat,backgroundColor)'
          }
        },
        // En-tête Réconciliation — fond vert, texte blanc, gras
        {
          repeatCell: {
            range: { sheetId: 1, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: {
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              backgroundColor: { red: 0.12, green: 0.45, blue: 0.29 }
            }},
            fields: 'userEnteredFormat(textFormat,backgroundColor)'
          }
        },
        // Colonne montant Réconciliation — format monétaire
        {
          repeatCell: {
            range: { sheetId: 1, startRowIndex: 1, endRowIndex: 1 + rowsR.length, startColumnIndex: 0, endColumnIndex: 1 },
            cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } } },
            fields: 'userEnteredFormat.numberFormat'
          }
        },
        // Freeze row 1 on both sheets
        { updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
        { updateSheetProperties: { properties: { sheetId: 1, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
        // Auto-resize all columns — Factures
        { autoResizeDimensions: { dimensions: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: 12 } } },
        // Auto-resize all columns — Réconciliation
        { autoResizeDimensions: { dimensions: { sheetId: 1, dimension: 'COLUMNS', startIndex: 0, endIndex: 10 } } }
      ]
    })
  });

  return `https://docs.google.com/spreadsheets/d/${id}`;
}

async function sheetsRequest(path, options = {}, isCreate = false) {
  const base = isCreate
    ? 'https://sheets.googleapis.com/v4/spreadsheets'
    : `https://sheets.googleapis.com/v4/spreadsheets`;
  const url = isCreate ? base : `${base}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) throw new Error(`Sheets error: ${res.status}`);
  return res.json();
}
