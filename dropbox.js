// AGES STYLE — Connexion au Dropbox de l'ingénieur
//
// Principe : l'app Dropbox est de type « App folder » — elle ne voit QUE le dossier
// Applications/AgesStyle-Catalogue du Dropbox de l'ingénieur, rien d'autre.
// Le serveur synchronise ce dossier vers ./catalogue-dropbox toutes les 60 secondes :
// ajout, modification, suppression — tout suit automatiquement.

const fs = require('fs');
const path = require('path');

const RACINE = __dirname;
const FICHIER_CONFIG = path.join(RACINE, 'dropbox-config.json'); // clés + jeton (privé !)
const FICHIER_ETAT = path.join(RACINE, 'dropbox-etat.json');     // mémoire de la dernière sync
const FICHIER_COUVERTURES = path.join(RACINE, 'couvertures.json'); // photos taguées « cover »
const DOSSIER_SYNC = path.join(RACINE, 'catalogue-dropbox');     // copie locale du Dropbox

const EXT_UTILES = ['.jpg', '.jpeg', '.png', '.webp', '.svg', '.glb', '.stl'];

let config = null;      // { app_key, app_secret, refresh_token }
let jeton = null;       // { access_token, expire }
let syncEnCours = false;
let etatSync = { derniereSync: null, nbFichiers: 0, erreur: null };

function chargerConfig() {
  // Sur le robot GitHub (mise en ligne), les clés arrivent par variables
  // d'environnement secrètes ; en local, par le fichier dropbox-config.json.
  if (process.env.DROPBOX_APP_KEY && process.env.DROPBOX_REFRESH_TOKEN) {
    config = {
      app_key: process.env.DROPBOX_APP_KEY,
      app_secret: process.env.DROPBOX_APP_SECRET || '',
      refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
    };
    return;
  }
  try { config = JSON.parse(fs.readFileSync(FICHIER_CONFIG, 'utf8')); }
  catch (e) { config = null; }
}
chargerConfig();

function sauverConfig() {
  fs.writeFileSync(FICHIER_CONFIG, JSON.stringify(config, null, 2));
}

function aLesCles() { return !!(config && config.app_key && config.app_secret); }
function estConnecte() { return !!(aLesCles() && config.refresh_token); }

function definirCles(app_key, app_secret) {
  config = { app_key: app_key.trim(), app_secret: app_secret.trim() };
  sauverConfig();
}

// URL où l'ingénieur autorise l'accès (token_access_type=offline → jeton permanent)
function urlAutorisation(redirection) {
  return 'https://www.dropbox.com/oauth2/authorize'
    + '?client_id=' + encodeURIComponent(config.app_key)
    + '&response_type=code&token_access_type=offline'
    + '&redirect_uri=' + encodeURIComponent(redirection);
}

// Après autorisation, Dropbox renvoie un code → on l'échange contre le jeton permanent
async function echangerCode(code, redirection) {
  const rep = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, grant_type: 'authorization_code',
      client_id: config.app_key, client_secret: config.app_secret,
      redirect_uri: redirection,
    }),
  });
  if (!rep.ok) throw new Error('Échange du code refusé : ' + await rep.text());
  const d = await rep.json();
  config.refresh_token = d.refresh_token;
  sauverConfig();
  jeton = null;
}

// Jeton d'accès temporaire (renouvelé automatiquement via le refresh_token)
async function jetonAcces() {
  if (jeton && Date.now() < jeton.expire - 60000) return jeton.access_token;
  const rep = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: config.refresh_token,
      client_id: config.app_key, client_secret: config.app_secret,
    }),
  });
  if (!rep.ok) throw new Error('Renouvellement du jeton refusé : ' + await rep.text());
  const d = await rep.json();
  jeton = { access_token: d.access_token, expire: Date.now() + d.expires_in * 1000 };
  return jeton.access_token;
}

async function apiDropbox(route, corps) {
  const t = await jetonAcces();
  const rep = await fetch('https://api.dropboxapi.com/2/' + route, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify(corps),
  });
  if (!rep.ok) throw new Error(route + ' : ' + await rep.text());
  return rep.json();
}

async function telechargerFichier(cheminDropbox, cheminLocal) {
  const t = await jetonAcces();
  const rep = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + t,
      'Dropbox-API-Arg': JSON.stringify({ path: cheminDropbox }),
    },
  });
  if (!rep.ok) throw new Error('Téléchargement : ' + await rep.text());
  fs.mkdirSync(path.dirname(cheminLocal), { recursive: true });
  fs.writeFileSync(cheminLocal, Buffer.from(await rep.arrayBuffer()));
}

// Lit les tags Dropbox des photos : celles taguées « cover » deviennent
// la couverture de leur dossier. Résultat écrit dans couvertures.json.
let dernierScanTags = 0;
let tagsDisponibles = true;

async function rafraichirCouvertures(distant) {
  const cheminsImages = Object.values(distant)
    .map((i) => i.cheminApi)
    .filter((c) => /\.(jpg|jpeg|png|webp|svg)$/i.test(c));

  const couvertures = {};
  for (let i = 0; i < cheminsImages.length; i += 20) {
    const lot = cheminsImages.slice(i, i + 20);
    const rep = await apiDropbox('files/tags/get', { paths: lot });
    for (const r of rep.paths_to_tags || []) {
      const estCover = (r.tags || []).some(
        (t) => (t.tag_text || '').toLowerCase().trim() === 'cover'
      );
      if (!estCover) continue;
      const relatif = r.path.replace(/^\//, ''); // ex : doors/door handle/photo.png
      const coupe = relatif.lastIndexOf('/');
      const dossier = coupe >= 0 ? relatif.slice(0, coupe) : '';
      const fichier = coupe >= 0 ? relatif.slice(coupe + 1) : relatif;
      if (!couvertures[dossier]) couvertures[dossier] = fichier;
    }
  }
  fs.writeFileSync(FICHIER_COUVERTURES, JSON.stringify(couvertures, null, 2));
  return Object.keys(couvertures).length;
}

// La synchronisation : compare le Dropbox avec la copie locale et met à jour
async function synchroniser(forcerTags) {
  if (!estConnecte() || syncEnCours) return etatSync;
  syncEnCours = true;
  try {
    // 1. Liste complète du dossier de l'app (toutes les catégories)
    const entrees = [];
    let page = await apiDropbox('files/list_folder', { path: '', recursive: true });
    entrees.push(...page.entries);
    while (page.has_more) {
      page = await apiDropbox('files/list_folder/continue', { cursor: page.cursor });
      entrees.push(...page.entries);
    }

    // 2. On garde les fichiers utiles (images + 3D) : chemin relatif → empreinte
    const distant = {};
    for (const e of entrees) {
      if (e['.tag'] !== 'file') continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!EXT_UTILES.includes(ext)) continue;
      const relatif = e.path_display.replace(/^\//, '');
      if (relatif.includes('..')) continue;
      distant[relatif] = { hash: e.content_hash, cheminApi: e.path_lower };
    }

    // 3. Comparaison avec la dernière sync
    let ancien = {};
    try { ancien = JSON.parse(fs.readFileSync(FICHIER_ETAT, 'utf8')); } catch (e) {}

    for (const [relatif, info] of Object.entries(distant)) {
      const cheminLocal = path.join(DOSSIER_SYNC, relatif);
      const inchange = ancien[relatif] === info.hash && fs.existsSync(cheminLocal);
      if (!inchange) await telechargerFichier(info.cheminApi, cheminLocal);
    }

    // 4. Ce qui a été supprimé du Dropbox est supprimé de la copie locale
    for (const relatif of Object.keys(ancien)) {
      if (!distant[relatif]) {
        try { fs.unlinkSync(path.join(DOSSIER_SYNC, relatif)); } catch (e) {}
      }
    }

    // 5. On mémorise l'état pour la prochaine fois
    const nouvelEtat = {};
    for (const [relatif, info] of Object.entries(distant)) nouvelEtat[relatif] = info.hash;
    const listeModifiee = JSON.stringify(nouvelEtat) !== JSON.stringify(ancien);
    fs.writeFileSync(FICHIER_ETAT, JSON.stringify(nouvelEtat, null, 2));

    // 6. Tags « cover » : relus si les fichiers ont bougé, toutes les 5 minutes,
    //    ou immédiatement quand on force (bouton « Synchroniser maintenant »).
    //    ⚠ Dropbox interdit les tags aux apps « App folder » : si c'est le cas,
    //    on désactive proprement et la sync continue sans les tags.
    let nbCouvertures;
    if (tagsDisponibles && (forcerTags || listeModifiee || Date.now() - dernierScanTags > 5 * 60 * 1000)) {
      try {
        nbCouvertures = await rafraichirCouvertures(distant);
        dernierScanTags = Date.now();
      } catch (e) {
        tagsDisponibles = false;
        console.log('ℹ Tags Dropbox indisponibles (app « App folder ») — couvertures par « ! » uniquement.');
      }
    }

    etatSync = {
      derniereSync: new Date().toISOString(),
      nbFichiers: Object.keys(distant).length,
      nbCouvertures: nbCouvertures !== undefined ? nbCouvertures : etatSync.nbCouvertures,
      erreur: null,
    };
  } catch (e) {
    etatSync = { ...etatSync, erreur: String(e.message || e) };
    console.log('⚠ Sync Dropbox :', etatSync.erreur);
  } finally {
    syncEnCours = false;
  }
  return etatSync;
}

// Sync automatique toutes les 60 secondes
function demarrerSyncAuto() {
  if (!estConnecte()) return;
  synchroniser();
  setInterval(synchroniser, 60 * 1000);
}

function etat() {
  return {
    clesEnregistrees: aLesCles(),
    connecte: estConnecte(),
    ...etatSync,
  };
}

module.exports = {
  DOSSIER_SYNC,
  aLesCles, estConnecte, definirCles,
  urlAutorisation, echangerCode,
  synchroniser, demarrerSyncAuto, etat,
  // utilisés par construire-site.js (version statique / mise en ligne gratuite)
  apiDropbox, telechargerFichier,
};
