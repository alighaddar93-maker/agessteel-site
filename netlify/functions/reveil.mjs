// AGES STEEL — Le réveil de secours
// Netlify exécute cette fonction toutes les 30 minutes, pile à l'heure,
// et elle sonne GitHub pour forcer le robot de synchronisation à se lever
// (le réveil interne de GitHub est souvent en retard, celui-ci jamais).

export default async () => {
  const reponse = await fetch(
    'https://api.github.com/repos/alighaddar93-maker/agessteel-site/actions/workflows/synchronisation.yml/dispatches',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN_REVEIL,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'agessteel-reveil',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    }
  );
  // 204 = GitHub a bien reçu le coup de sonnette
  console.log('Réveil du robot GitHub — réponse :', reponse.status);
};

// Toutes les 30 minutes, aux minutes 3 et 33 (décalées du réveil interne de GitHub)
export const config = { schedule: '3,33 * * * *' };
