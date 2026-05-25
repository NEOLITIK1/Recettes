# NEOLITIK — App de production

Application de gestion des recettes, stock et batchs de production EcoLithe®.

## Stack

- **React 18** + Vite
- **React Router v6** — navigation par URLs
- **Supabase** — base de données PostgreSQL cloud
- **Tailwind CSS** — styles
- **Vercel** — déploiement

---

## Installation locale

### 1. Cloner et installer

```bash
git clone <ton-repo>
cd neolitik-app
npm install
```

### 2. Créer le projet Supabase

1. Aller sur [supabase.com](https://supabase.com) → New project
2. Copier l'URL et la clé anon (Settings → API)
3. Dans SQL Editor → New query, coller le contenu de `supabase/schema.sql` et cliquer Run

### 3. Configurer les variables d'environnement

```bash
cp .env.example .env
```

Éditer `.env` :
```
VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

### 4. Lancer en développement

```bash
npm run dev
```

Ouvrir http://localhost:5173

### 5. Importer les données initiales

Au premier lancement :
- Page **Matières premières** → cliquer "Importer données initiales" (42 MP)
- Page **Recettes cibles** → cliquer "Importer recettes initiales" (3 recettes)
- Page **Historique** → cliquer "Importer 20 batchs historiques"

---

## Déploiement Vercel

### 1. Pousser sur GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<ton-compte>/neolitik-app.git
git push -u origin main
```

### 2. Connecter à Vercel

1. Aller sur [vercel.com](https://vercel.com) → Add New Project
2. Importer le dépôt GitHub
3. Framework preset : **Vite**
4. Dans Environment Variables, ajouter :
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
5. Cliquer Deploy

L'appli est en ligne en 2 minutes.

---

## Structure du projet

```
src/
├── lib/
│   ├── supabase.js      # Client Supabase
│   └── calculs.js       # Calcul composition + coût batch
├── data/
│   └── seed.js          # Données initiales (42 MP, 3 recettes, 20 batchs)
├── components/
│   ├── Layout.jsx        # Sidebar + navigation
│   ├── Modal.jsx         # Composant modal réutilisable
│   ├── CompositionBar.jsx # Barre visuelle de composition
│   └── EcartBadge.jsx    # Badge écart vert/orange/rouge
└── pages/
    ├── MatieresPremières.jsx
    ├── Recettes.jsx
    ├── Stock.jsx
    ├── Optimiseur.jsx
    └── Historique.jsx
```

---

## Évolutions prévues

- [ ] Authentification (Supabase Auth) avec rôles opérateur / responsable
- [ ] Optimiseur v2 — algorithme combinatoire (meilleurs résultats sur stocks hétérogènes)
- [ ] Suggestion automatique de correction de batch
- [ ] Création de MP "Reste de batch" depuis l'historique
- [ ] Export PDF de la fiche batch pour l'atelier
