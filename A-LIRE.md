# AGES STYLE — Site catalogue (version d'essai)

Site vitrine + catalogue pour la société **Ages Style** (ferronnerie & décoration en fer).
Domaine prévu : **agesstyle.com** (pas encore branché — on développe d'abord).

## Comment ça marche

- `server.js` — le serveur du site (Node, sans aucune dépendance à installer)
- `public/index.html` — la page du site (accueil, catalogue, contact)
- `catalogue/` — **le cœur du système** : ce dossier simule le futur Dropbox de l'ingénieur
  - 1 sous-dossier = 1 catégorie (ex : `Portails/`, `Escaliers/`)
  - 1 image (JPG/PNG/SVG/WebP) = 1 design affiché sur le site
  - Le nom du fichier devient le nom du design (`portail-royal.svg` → « Portail royal »)
  - Ajouter/supprimer un fichier → le site se met à jour au prochain rechargement de page

## Compression automatique des photos ✅

L'ingénieur peut déposer des photos de n'importe quelle taille : le site fabrique
tout seul des versions légères pour l'affichage (WebP — petite pour la grille,
grande pour la fiche) et les garde dans `cache-images/` (dossier auto-généré,
peut être supprimé sans risque). **L'original n'est jamais modifié.**
Testé : une photo de 1,4 Mo est servie à 92 Ko dans la grille (15× plus légère).
Nécessite `npm install` (module `sharp`) ; sans lui, le site marche quand même
mais sert les originaux.

## Lancer le site

```
npm install
node server.js
```

Puis ouvrir http://localhost:4600

## Connexion Dropbox ✅ (mécanisme prêt — activation avec l'ingénieur)

Tout le code est en place (`dropbox.js`). Pour activer, ouvrir
**http://localhost:4600/dropbox-setup** : la page guide pas à pas
(l'ingénieur crée une app Dropbox « App folder » sur SON compte — 5 minutes —
puis colle les clés et autorise). Ensuite :

- L'app ne voit QUE le dossier `Applications/AgesStyle-Catalogue` de son Dropbox
- Synchronisation automatique toutes les 60 secondes (ajouts, modifs, suppressions)
- La copie locale synchronisée est dans `catalogue-dropbox/`
- Tant que Dropbox n'est pas connecté, le site utilise le dossier local `catalogue/`
- Les clés sont dans `dropbox-config.json` — **fichier secret, ne jamais partager**

## À faire plus tard

1. **Activer le Dropbox** avec l'ingénieur (voir ci-dessus)
2. **Vue 3D interactive** : l'ingénieur exporte aussi en 3D (SolidWorks → GLB/STL),
   le client tourne le design dans son navigateur
3. **Numéro WhatsApp réel** : remplacer `NUMERO_WHATSAPP` dans `public/index.html`
   (actuellement un numéro bidon `241000000000`)
4. **Vraies photos/rendus** : les SVG actuels sont des démonstrations
5. **Mise en ligne** sur agesstyle.com (le webhook Dropbox temps réel pourra
   s'ajouter à ce moment-là ; en attendant la sync 60 s suffit largement)

⚠️ Règle du projet (comme PadelGabon) : rien n'est mis en ligne sans le « publie » explicite d'Ali.
