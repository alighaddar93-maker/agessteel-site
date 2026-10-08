// AGES STYLE — serveur du site catalogue
// Version d'essai : le catalogue est lu depuis le dossier local ./catalogue
// (plus tard, ce dossier sera synchronisé avec le Dropbox de l'ingénieur)

const http = require('http');
const fs = require('fs');
const path = require('path');
const dropbox = require('./dropbox.js');

// Compression d'images (facultatif : si sharp n'est pas installé, on sert les originaux)
let sharp = null;
try { sharp = require('sharp'); } catch (e) {
  console.log('⚠ sharp non installé — les images seront servies sans compression');
}

const PORT = 4600;
const RACINE = __dirname;
const DOSSIER_PUBLIC = path.join(RACINE, 'public');
const DOSSIER_CATALOGUE = path.join(RACINE, 'catalogue');
const DOSSIER_CACHE = path.join(RACINE, 'cache-images');

// Tailles générées automatiquement (l'original n'est jamais modifié)
const TAILLES = {
  vignette: { largeur: 640, qualite: 78 },  // pour la grille du catalogue
  grande: { largeur: 1400, qualite: 82 },   // pour la fiche en grand
};
const EXT_COMPRESSIBLES = ['.jpg', '.jpeg', '.png', '.webp'];

const EXT_IMAGES = ['.jpg', '.jpeg', '.png', '.webp', '.svg'];
const EXT_3D = ['.glb', '.stl'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.stl': 'model/stl',
  '.ico': 'image/x-icon',
};

// Si le Dropbox de l'ingénieur est connecté, le catalogue vient de la copie
// synchronisée ; sinon, du dossier local (mode essai / secours)
function dossierCatalogueActif() {
  return dropbox.estConnecte() ? dropbox.DOSSIER_SYNC : DOSSIER_CATALOGUE;
}

// Couvertures choisies avec le tag « cover » sur dropbox.com
// (fichier écrit par la synchronisation ; clés en minuscules : dossier → fichier)
const FICHIER_COUVERTURES = path.join(RACINE, 'couvertures.json');
let cacheCouvertures = { date: -1, table: {} };

function chargerCouvertures() {
  try {
    const date = fs.statSync(FICHIER_COUVERTURES).mtimeMs;
    if (date !== cacheCouvertures.date) {
      cacheCouvertures = { date, table: JSON.parse(fs.readFileSync(FICHIER_COUVERTURES, 'utf8')) };
    }
  } catch (e) { cacheCouvertures = { date: -1, table: {} }; }
  return cacheCouvertures.table;
}

// ---------- Traduction des noms (anglais → français) ----------
// Le dictionnaire est dans traductions.json : modifiable à chaud, sans redémarrer.
const FICHIER_TRADUCTIONS = path.join(RACINE, 'traductions.json');
let cacheTraductions = { date: 0, entrees: [] };

function chargerTraductions() {
  try {
    const date = fs.statSync(FICHIER_TRADUCTIONS).mtimeMs;
    if (date !== cacheTraductions.date) {
      const brut = JSON.parse(fs.readFileSync(FICHIER_TRADUCTIONS, 'utf8'));
      const entrees = Object.entries(brut)
        .filter(([cle]) => !cle.startsWith('_'))
        // Les expressions longues d'abord : « swing door » gagne sur « door »
        .sort((a, b) => b[0].length - a[0].length)
        .map(([anglais, francais]) => ({
          regex: new RegExp('\\b' + anglais.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '\\s+') + '\\b', 'gi'),
          francais,
        }));
      cacheTraductions = { date, entrees };
    }
  } catch (e) { /* pas de dictionnaire → pas de traduction, le site marche quand même */ }
  return cacheTraductions.entrees;
}

function traduire(texte) {
  let resultat = texte;
  for (const t of chargerTraductions()) {
    resultat = resultat.replace(t.regex, t.francais);
  }
  return resultat.charAt(0).toUpperCase() + resultat.slice(1);
}

// Transforme "swing-door_2.png" en "Porte battante 2"
// Le « ! » de couverture (fin ou début du nom) est effacé : le client ne le voit jamais
function joliNom(nomFichier) {
  const sansExt = nomFichier.replace(path.extname(nomFichier), '');
  const mots = sansExt.replace(/^!+|!+$/g, '').replace(/[-_]+/g, ' ').trim();
  return traduire(mots);
}

// Scanne le catalogue en profondeur : les dossiers peuvent contenir des
// sous-dossiers ET des photos, sur autant de niveaux que l'ingénieur veut.
function lireNoeud(cheminAbs, urlBase) {
  const noeud = { dossiers: [], designs: [] };
  if (!fs.existsSync(cheminAbs)) return noeud;

  const parBase = {};
  for (const entree of fs.readdirSync(cheminAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'fr'))) {
    if (entree.isDirectory()) {
      const enfant = lireNoeud(
        path.join(cheminAbs, entree.name),
        urlBase + '/' + encodeURIComponent(entree.name)
      );
      enfant.nom = traduire(entree.name);
      if (enfant.compte > 0) noeud.dossiers.push(enfant);
      continue;
    }
    // On regroupe par nom de base : image + éventuel fichier 3D du même nom
    const ext = path.extname(entree.name).toLowerCase();
    const base = entree.name.replace(path.extname(entree.name), '');
    if (!EXT_IMAGES.includes(ext) && !EXT_3D.includes(ext)) continue;
    if (!parBase[base]) parBase[base] = {};
    if (EXT_IMAGES.includes(ext)) parBase[base].image = entree.name;
    if (EXT_3D.includes(ext)) parBase[base].modele3d = entree.name;
  }

  // Choix de la photo de couverture du dossier (celle qui « sort dehors ») :
  // 1. la photo taguée « cover » sur dropbox.com (recommandé — invisible partout)
  // 2. sinon, une photo dont le nom commence par « ! »
  // 3. sinon, une photo nommée exactement « cover » ou « couverture » → jamais listée
  // 4. sinon, la première photo du dossier
  let couvertureTag = null;
  let couvertureDediee = null;
  let couvertureMarquee = null;
  const relDossier = path.relative(dossierCatalogueActif(), cheminAbs)
    .split(path.sep).join('/').toLowerCase();
  const fichierTague = chargerCouvertures()[relDossier];

  for (const base of Object.keys(parBase).sort()) {
    const d = parBase[base];
    if (!d.image) continue; // un design sans image ne s'affiche pas
    const urlImage = urlBase + '/' + encodeURIComponent(d.image);

    if (fichierTague && d.image.toLowerCase() === fichierTague) {
      couvertureTag = urlImage;
    }
    if (/^(cover|couverture)$/i.test(base.trim())) {
      couvertureDediee = urlImage;
      continue; // photo réservée à la couverture : pas dans la grille
    }
    if (!couvertureMarquee && (base.trim().endsWith('!') || base.startsWith('!'))) {
      couvertureMarquee = urlImage;
    }

    noeud.designs.push({
      nom: joliNom(d.image),
      image: urlImage,
      modele3d: d.modele3d ? urlBase + '/' + encodeURIComponent(d.modele3d) : null,
    });
  }

  // Total de designs (sous-dossiers compris) + image de couverture du dossier
  noeud.compte = noeud.designs.length + noeud.dossiers.reduce((s, d) => s + d.compte, 0);
  noeud.couverture = couvertureTag || couvertureMarquee || couvertureDediee
    || (noeud.designs[0] ? noeud.designs[0].image : null)
    || (noeud.dossiers[0] ? noeud.dossiers[0].couverture : null);

  return noeud;
}

function lireCatalogue() {
  return lireNoeud(dossierCatalogueActif(), '/catalogue');
}

// Filigrane « AGES STEEL » répété en diagonale, en transparence.
// Blanc + contour sombre : visible sur les fonds clairs comme sur les foncés.
function filigrane(largeur, hauteur) {
  const taillePolice = Math.max(18, Math.round(largeur / 14));
  const tuileL = taillePolice * 9;
  const tuileH = taillePolice * 4.5;
  const svg = `<svg width="${largeur}" height="${hauteur}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <pattern id="marque" width="${tuileL}" height="${tuileH}" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
      <text x="0" y="${taillePolice * 1.2}"
        font-family="Arial, Helvetica, sans-serif" font-size="${taillePolice}" font-weight="bold"
        letter-spacing="${Math.round(taillePolice / 8)}"
        fill="#ffffff" fill-opacity="0.26"
        stroke="#1a1a1a" stroke-opacity="0.22" stroke-width="1">AGES STEEL</text>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="url(#marque)"/>
</svg>`;
  return Buffer.from(svg);
}

// Sert une version compressée de l'image (fabriquée une fois, puis gardée en cache).
// Si la compression échoue, on sert l'original — le site ne casse jamais.
async function envoyerImageCompressee(res, cheminOriginal, taille) {
  const reglage = TAILLES[taille];
  const relatif = path.relative(dossierCatalogueActif(), cheminOriginal);
  const cheminCache = path.join(
    DOSSIER_CACHE,
    relatif.replace(path.extname(relatif), '') + '-' + taille + '.webp'
  );

  try {
    const infoOriginal = fs.statSync(cheminOriginal);

    // Le cache est-il déjà à jour ? (refait si l'ingénieur a modifié la photo)
    let cacheValide = false;
    if (fs.existsSync(cheminCache)) {
      cacheValide = fs.statSync(cheminCache).mtimeMs >= infoOriginal.mtimeMs;
    }

    if (!cacheValide) {
      fs.mkdirSync(path.dirname(cheminCache), { recursive: true });
      // limitInputPixels élevé : les rendus SolidWorks de l'ingénieur sont géants
      const redimensionnee = await sharp(cheminOriginal, { limitInputPixels: 1000000000 })
        .rotate() // respecte l'orientation de la photo
        .resize({ width: reglage.largeur, withoutEnlargement: true })
        .toBuffer();
      const dims = await sharp(redimensionnee).metadata();
      // Filigrane AGES STEEL imprimé dans l'image : toute capture l'emporte avec
      await sharp(redimensionnee)
        .composite([{ input: filigrane(dims.width, dims.height) }])
        .webp({ quality: reglage.qualite })
        .toFile(cheminCache);
    }

    res.writeHead(200, {
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(fs.readFileSync(cheminCache));
  } catch (e) {
    envoyerFichier(res, cheminOriginal); // secours : l'original
  }
}

function envoyerFichier(res, chemin) {
  const ext = path.extname(chemin).toLowerCase();
  fs.readFile(chemin, (err, contenu) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Introuvable');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(contenu);
  });
}

// Lit le corps JSON d'une requête POST
function lireCorpsJson(req, suite) {
  let brut = '';
  req.on('data', (morceau) => { brut += morceau; if (brut.length > 100000) req.destroy(); });
  req.on('end', () => {
    try { suite(JSON.parse(brut)); } catch (e) { suite(null); }
  });
}

// L'adresse de retour après autorisation Dropbox (doit être déclarée dans l'app Dropbox)
function urlRetour(req) {
  return 'http://' + (req.headers.host || 'localhost:' + PORT) + '/dropbox-retour';
}

const serveur = http.createServer((req, res) => {
  const [cheminBrut, paramsBruts] = req.url.split('?');
  const url = decodeURIComponent(cheminBrut);
  const params = new URLSearchParams(paramsBruts || '');

  // API : le catalogue en JSON (depuis Dropbox si connecté, sinon dossier local)
  if (url === '/api/catalogue') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(lireCatalogue()));
    return;
  }

  // ---------- Connexion Dropbox (réservé à l'administrateur, en local) ----------
  const estLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

  if (url === '/dropbox-setup' || url.startsWith('/api/dropbox/') || url === '/dropbox-retour') {
    if (!estLocal) { res.writeHead(403); res.end('Accès réservé'); return; }
  }

  // La page d'installation guidée
  if (url === '/dropbox-setup') {
    envoyerFichier(res, path.join(DOSSIER_PUBLIC, 'dropbox-setup.html'));
    return;
  }

  // État de la connexion
  if (url === '/api/dropbox/etat') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(dropbox.etat()));
    return;
  }

  // Enregistrer les clés de l'app → renvoie l'URL d'autorisation Dropbox
  if (url === '/api/dropbox/config' && req.method === 'POST') {
    lireCorpsJson(req, (corps) => {
      if (!corps || !corps.app_key || !corps.app_secret) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ erreur: 'Il faut la App key et le App secret' }));
        return;
      }
      dropbox.definirCles(corps.app_key, corps.app_secret);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ url: dropbox.urlAutorisation(urlRetour(req)) }));
    });
    return;
  }

  // Retour de Dropbox après l'autorisation de l'ingénieur
  if (url === '/dropbox-retour') {
    const code = params.get('code');
    if (!code) {
      res.writeHead(302, { Location: '/dropbox-setup?erreur=autorisation-refusee' });
      res.end();
      return;
    }
    dropbox.echangerCode(code, urlRetour(req))
      .then(() => dropbox.synchroniser())
      .then(() => {
        dropbox.demarrerSyncAuto();
        res.writeHead(302, { Location: '/dropbox-setup?ok=1' });
        res.end();
      })
      .catch((e) => {
        console.log('⚠ Connexion Dropbox :', e.message);
        res.writeHead(302, { Location: '/dropbox-setup?erreur=echange-code' });
        res.end();
      });
    return;
  }

  // Connexion à distance : l'ingénieur a autorisé sur SON ordinateur, il voit une
  // page d'erreur localhost (normal), il envoie l'adresse complète → on la colle ici
  if (url === '/api/dropbox/code' && req.method === 'POST') {
    lireCorpsJson(req, (corps) => {
      let code = (corps && corps.code || '').trim();
      // On accepte l'adresse complète collée telle quelle, ou juste le code
      const trouve = code.match(/code=([A-Za-z0-9_-]+)/);
      if (trouve) code = trouve[1];
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ erreur: 'Aucun code trouvé dans ce qui a été collé' }));
        return;
      }
      dropbox.echangerCode(code, 'http://localhost:' + PORT + '/dropbox-retour')
        .then(() => dropbox.synchroniser())
        .then((etat) => {
          dropbox.demarrerSyncAuto();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, ...etat }));
        })
        .catch((e) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ erreur: e.message }));
        });
    });
    return;
  }

  // Forcer une synchronisation immédiate (avec relecture des tags « cover »)
  if (url === '/api/dropbox/sync' && req.method === 'POST') {
    dropbox.synchroniser(true).then((etat) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(etat));
    });
    return;
  }

  // Fichiers du catalogue (images des designs)
  if (url.startsWith('/catalogue/')) {
    const dossierActif = dossierCatalogueActif();
    const chemin = path.join(dossierActif, url.replace('/catalogue/', ''));
    if (!chemin.startsWith(dossierActif)) {
      res.writeHead(403); res.end(); return;
    }

    // Compression automatique : ?taille=vignette ou ?taille=grande
    const taille = params.get('taille');
    const ext = path.extname(chemin).toLowerCase();
    if (sharp && TAILLES[taille] && EXT_COMPRESSIBLES.includes(ext) && fs.existsSync(chemin)) {
      envoyerImageCompressee(res, chemin, taille);
      return;
    }

    envoyerFichier(res, chemin);
    return;
  }

  // Fichiers du site
  const cheminPublic = path.join(DOSSIER_PUBLIC, url === '/' ? 'index.html' : url);
  if (!cheminPublic.startsWith(DOSSIER_PUBLIC)) {
    res.writeHead(403); res.end(); return;
  }
  envoyerFichier(res, cheminPublic);
});

serveur.listen(PORT, () => {
  console.log('AGES STYLE — site en marche sur http://localhost:' + PORT);
  if (dropbox.estConnecte()) {
    console.log('Dropbox connecté — synchronisation automatique toutes les 60 s');
    dropbox.demarrerSyncAuto();
  } else {
    console.log('Dropbox pas encore connecté — catalogue local. Installation : http://localhost:' + PORT + '/dropbox-setup');
  }
});
