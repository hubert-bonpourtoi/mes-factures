# Mes Factures — PWA

Application mobile pour scanner, classer et exporter vos factures pour les rapports TPS/TVQ.

---

## Structure des fichiers

```
factures-pwa/
├── index.html        — App principale + styles
├── app.js            — Logique, vues, navigation
├── db.js             — IndexedDB (stockage local)
├── google.js         — Drive + Sheets (OAuth)
├── sw.js             — Service Worker (hors ligne)
├── manifest.json     — Config PWA
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

---

## Déploiement sur GitHub Pages

### 1. Créer le dépôt GitHub

```bash
git init
git add .
git commit -m "Initial commit — Mes Factures PWA"
git branch -M main
git remote add origin https://github.com/VOTRE_USERNAME/mes-factures.git
git push -u origin main
```

### 2. Activer GitHub Pages

Dans les paramètres du dépôt :
- Settings → Pages → Source : **Branch: main / root**
- L'app sera accessible à : `https://VOTRE_USERNAME.github.io/mes-factures/`

---

## Configuration requise

### Clé API Anthropic

1. Allez sur https://console.anthropic.com
2. Créez une clé API
3. Dans l'app → Réglages → Collez la clé

### Google OAuth (Drive + Sheets)

1. Allez sur https://console.cloud.google.com
2. Créez un nouveau projet
3. Activez les APIs :
   - Google Drive API
   - Google Sheets API
4. Credentials → Créer → OAuth 2.0 Client ID
   - Type : Application Web
   - Origines autorisées : `https://VOTRE_USERNAME.github.io`
5. Copiez le Client ID
6. Dans l'app → Réglages → Collez le Client ID

---

## Installer sur iPhone

1. Ouvrez l'URL dans **Safari** (pas Chrome)
2. Appuyez sur le bouton Partager (carré avec flèche)
3. Choisissez **« Sur l'écran d'accueil »**
4. L'app apparaît comme une vraie app !

---

## Fonctionnalités

- 📷 **Scanner** — Photo via l'iPhone ou import galerie/PDF
- 🤖 **Extraction automatique** — Claude Vision lit TPS, TVQ, total, fournisseur, date
- 🏷 **Tags libres** — Taguez chaque facture comme vous voulez
- 📁 **Google Drive** — Photos classées dans : `Factures / 2025 / 04 - Avril / Épicerie /`
- 📊 **Google Sheets** — Export registre TPS/TVQ complet
- ⬇ **Export CSV** — Sans connexion Google
- 🔌 **Hors ligne** — Données stockées localement (IndexedDB)

---

## Structure Drive générée

```
Mon Drive/
└── Factures/
    └── 2025/
        ├── 01 - Janvier/
        │   ├── Épicerie/
        │   ├── Restaurant - repas d'affaires/
        │   └── Bureau - fournitures/
        └── 04 - Avril/
            └── Transport/
```

---

## Colonnes du rapport Google Sheets

| Date | Fournisseur | Catégorie | Tags | Sous-total | TPS | TVQ | Total | Type dépense | Notes | Drive URL |
