// Petit serveur de TEST local pour la version statique (dossier ./site)
// En ligne, c'est Netlify qui fait ce travail — ce fichier ne sert qu'aux essais.
const http = require('http');
const fs = require('fs');
const path = require('path');

const SITE = path.join(__dirname, 'site');
const PORT = 4601;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const chemin = path.join(SITE, url === '/' ? 'index.html' : url);
  if (!chemin.startsWith(SITE)) { res.writeHead(403); res.end(); return; }
  fs.readFile(chemin, (err, contenu) => {
    if (err) { res.writeHead(404); res.end('Introuvable'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(chemin).toLowerCase()] || 'application/octet-stream' });
    res.end(contenu);
  });
}).listen(PORT, () => console.log('Test statique : http://localhost:' + PORT));
