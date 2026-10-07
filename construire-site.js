// AGES STEEL — Fabrique le site statique complet dans ./site
//
// Ce script est exécuté par le robot GitHub toutes les 30 minutes :
//  1. Il liste le Dropbox de l'ingénieur
//  2. Pour chaque photo nouvelle ou modifiée : il la télécharge, fabrique les
//     deux versions compressées AVEC le filigrane AGES STEEL, puis jette l'original
//  3. Il supprime du site ce qui a disparu du Dropbox
//  4. Il écrit catalogue.json (l'arborescence traduite en français) + la page
//
// Les photos déjà transformées ne sont JAMAIS refaites (comparaison par empreinte),
// donc un passage sans nouveauté ne télécharge rien et dure moins d'une minute.
//
// Usage : node construire-site.js

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const dropbox = require('./dropbox.js');

const RACINE = __dirname;
const SITE = path.join(RACINE, 'site');
const DOSSIER_IMAGES = path.join(SITE, 'images');
const MODELE = path.join(RACINE, 'modele');
const ETAT_SITE = path.join(SITE, 'etat-sync.json');     // empreinte de chaque photo transformée
const MIROIR = dropbox.DOSSIER_SYNC;                      // copie locale (sur le Mac uniquement)
const ETAT_MIROIR = path.join(RACINE, 'dropbox-etat.json');
const TMP = path.join(RACINE, 'tmp-originaux');

const EXT_PHOTOS = ['.jpg', '.jpeg', '.png', '.webp'];
const TAILLES = {
  vignette: { largeur: 640, qualite: 78, suffixe: '-v' },
  grande: { largeur: 1400, qualite: 82, suffixe: '-g' },
};

// ---------- Traduction (même dictionnaire que le site local) ----------
let entreesTraduction = [];
try {
  const brut = JSON.parse(fs.readFileSync(path.join(RACINE, 'traductions.json'), 'utf8'));
  entreesTraduction = Object.entries(brut)
    .filter(([cle]) => !cle.startsWith('_'))
    .sort((a, b) => b[0].length - a[0].length)
    .map(([anglais, francais]) => ({
      regex: new RegExp('\\b' + anglais.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'),
      francais,
    }));
} catch (e) { /* pas de dictionnaire → pas de traduction */ }

function traduire(texte) {
  let resultat = texte;
  for (const t of entreesTraduction) resultat = resultat.replace(t.regex, t.francais);
  return resultat.charAt(0).toUpperCase() + resultat.slice(1);
}

function joliNom(nomFichier) {
  const sansExt = nomFichier.replace(path.extname(nomFichier), '');
  const mots = sansExt.replace(/^!+|!+$/g, '').replace(/[-_]+/g, ' ').trim();
  return traduire(mots);
}

// ---------- Filigrane AGES STEEL (identique au site local) ----------
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

// ---------- Transformation d'une photo : 2 tailles filigranées ----------
function cheminsSortie(rel) {
  const sansExt = rel.replace(path.extname(rel), '');
  return {
    vignette: path.join(DOSSIER_IMAGES, sansExt + '-v.webp'),
    grande: path.join(DOSSIER_IMAGES, sansExt + '-g.webp'),
    relVignette: 'images/' + sansExt + '-v.webp',
    relGrande: 'images/' + sansExt + '-g.webp',
  };
}

async function transformer(cheminOriginal, rel) {
  const sorties = cheminsSortie(rel);
  for (const nomTaille of Object.keys(TAILLES)) {
    const reglage = TAILLES[nomTaille];
    const cible = nomTaille === 'vignette' ? sorties.vignette : sorties.grande;
    fs.mkdirSync(path.dirname(cible), { recursive: true });
    const redimensionnee = await sharp(cheminOriginal, { limitInputPixels: 1000000000 })
      .rotate()
      .resize({ width: reglage.largeur, withoutEnlargement: true })
      .toBuffer();
    const dims = await sharp(redimensionnee).metadata();
    await sharp(redimensionnee)
      .composite([{ input: filigrane(dims.width, dims.height) }])
      .webp({ quality: reglage.qualite })
      .toFile(cible);
  }
}

// ---------- L'original : copie locale si disponible, sinon téléchargement ----------
let etatMiroir = {};
try { etatMiroir = JSON.parse(fs.readFileSync(ETAT_MIROIR, 'utf8')); } catch (e) {}

async function obtenirOriginal(rel, info) {
  const cheminMiroir = path.join(MIROIR, rel);
  if (etatMiroir[rel] === info.hash && fs.existsSync(cheminMiroir)) {
    return { chemin: cheminMiroir, temporaire: false };
  }
  const cheminTmp = path.join(TMP, rel);
  await dropbox.telechargerFichier(info.cheminApi, cheminTmp);
  return { chemin: cheminTmp, temporaire: true };
}

// ---------- Construction de l'arborescence du catalogue ----------
function construireArbre(fichiers) {
  // fichiers : { rel → { nomFichier } } — on monte l'arbre dossier par dossier
  const racine = { nom: '', dossiers: new Map(), designs: [] };

  for (const rel of Object.keys(fichiers).sort((a, b) => a.localeCompare(b, 'fr'))) {
    const segments = rel.split('/');
    const nomFichier = segments.pop();
    let noeud = racine;
    for (const segment of segments) {
      if (!noeud.dossiers.has(segment)) {
        noeud.dossiers.set(segment, { nom: segment, dossiers: new Map(), designs: [] });
      }
      noeud = noeud.dossiers.get(segment);
    }
    noeud.designs.push({ nomFichier, rel });
  }

  // Transforme récursivement en JSON final : traduction, couvertures, compteurs
  function finaliser(noeud) {
    const resultat = { nom: traduire(noeud.nom || ''), dossiers: [], designs: [] };
    let couvertureMarquee = null;
    let couvertureDediee = null;

    for (const d of noeud.designs) {
      const base = d.nomFichier.replace(path.extname(d.nomFichier), '');
      const sorties = cheminsSortie(d.rel);
      if (/^(cover|couverture)$/i.test(base.trim())) {
        couvertureDediee = sorties.relVignette;
        continue; // photo réservée à la couverture, pas dans la grille
      }
      if (!couvertureMarquee && (base.trim().endsWith('!') || base.startsWith('!'))) {
        couvertureMarquee = sorties.relVignette;
      }
      resultat.designs.push({
        nom: joliNom(d.nomFichier),
        vignette: sorties.relVignette,
        grande: sorties.relGrande,
      });
    }

    for (const enfant of [...noeud.dossiers.values()].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))) {
      const fini = finaliser(enfant);
      if (fini.compte > 0) resultat.dossiers.push(fini);
    }

    resultat.compte = resultat.designs.length
      + resultat.dossiers.reduce((s, x) => s + x.compte, 0);
    resultat.couverture = couvertureMarquee || couvertureDediee
      || (resultat.designs[0] ? resultat.designs[0].vignette : null)
      || (resultat.dossiers[0] ? resultat.dossiers[0].couverture : null);
    return resultat;
  }

  return finaliser(racine);
}

// ---------- Le chef d'orchestre ----------
async function principal() {
  if (!dropbox.estConnecte()) {
    console.error('❌ Clés Dropbox absentes (dropbox-config.json ou variables DROPBOX_*).');
    process.exit(1);
  }
  fs.mkdirSync(SITE, { recursive: true });
  fs.mkdirSync(DOSSIER_IMAGES, { recursive: true });

  // 1. Liste complète du Dropbox
  console.log('— Lecture du Dropbox de l\'ingénieur...');
  const entrees = [];
  let page = await dropbox.apiDropbox('files/list_folder', { path: '', recursive: true });
  entrees.push(...page.entries);
  while (page.has_more) {
    page = await dropbox.apiDropbox('files/list_folder/continue', { cursor: page.cursor });
    entrees.push(...page.entries);
  }

  const distant = {};
  for (const e of entrees) {
    if (e['.tag'] !== 'file') continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!EXT_PHOTOS.includes(ext)) continue;
    const rel = e.path_display.replace(/^\//, '');
    if (rel.includes('..')) continue;
    distant[rel] = { hash: e.content_hash, cheminApi: e.path_lower, nomFichier: e.name };
  }
  console.log('— ' + Object.keys(distant).length + ' photos dans le Dropbox');

  // 2. Quoi transformer ? (nouveau, modifié, ou sortie manquante)
  let ancien = {};
  try { ancien = JSON.parse(fs.readFileSync(ETAT_SITE, 'utf8')); } catch (e) {}

  let transformees = 0;
  for (const [rel, info] of Object.entries(distant)) {
    const sorties = cheminsSortie(rel);
    const dejaFait = ancien[rel] === info.hash
      && fs.existsSync(sorties.vignette) && fs.existsSync(sorties.grande);
    if (dejaFait) continue;

    const original = await obtenirOriginal(rel, info);
    await transformer(original.chemin, rel);
    if (original.temporaire) fs.rmSync(original.chemin, { force: true });
    transformees++;
    if (transformees % 100 === 0) console.log('  ... ' + transformees + ' photos transformées');
  }
  fs.rmSync(TMP, { recursive: true, force: true });

  // 3. Supprimer du site ce qui a disparu du Dropbox
  let supprimees = 0;
  for (const rel of Object.keys(ancien)) {
    if (!distant[rel]) {
      const sorties = cheminsSortie(rel);
      fs.rmSync(sorties.vignette, { force: true });
      fs.rmSync(sorties.grande, { force: true });
      supprimees++;
    }
  }

  // 4. Le catalogue en français + la page + le logo
  const arbre = construireArbre(distant);
  fs.writeFileSync(path.join(SITE, 'catalogue.json'), JSON.stringify(arbre));
  fs.copyFileSync(path.join(MODELE, 'index.html'), path.join(SITE, 'index.html'));
  fs.copyFileSync(path.join(MODELE, 'logo.png'), path.join(SITE, 'logo.png'));

  // 5. Mémoriser l'état pour le prochain passage
  const nouvelEtat = {};
  for (const [rel, info] of Object.entries(distant)) nouvelEtat[rel] = info.hash;
  fs.writeFileSync(ETAT_SITE, JSON.stringify(nouvelEtat, null, 1));

  console.log('✅ Site fabriqué : ' + Object.keys(distant).length + ' photos ('
    + transformees + ' transformées, ' + supprimees + ' supprimées)');
}

principal().catch((e) => { console.error('❌', e.message); process.exit(1); });
