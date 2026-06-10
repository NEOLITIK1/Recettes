import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { calcComposition, calcCout } from '../lib/calculs.js'

// Utilitaire dates
function startOfWeek(d) {
  const date = new Date(d)
  const day = date.getDay() // 0 = dim
  const diff = day === 0 ? -6 : 1 - day
  date.setDate(date.getDate() + diff)
  date.setHours(0, 0, 0, 0)
  return date
}
function startOfMonth(d) {
  const date = new Date(d)
  date.setDate(1)
  date.setHours(0, 0, 0, 0)
  return date
}
function fmtKg(kg) {
  if (kg >= 1000) return (kg / 1000).toFixed(1) + ' t'
  return Math.round(kg).toLocaleString('fr-FR') + ' kg'
}

export default function Dashboard() {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState({
    batches: [], lignes: [], recettes: [], sacs: [], mps: [], conso: [],
  })

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    const [b, l, r, s, m, c] = await Promise.all([
      supabase.from('batches').select('*'),
      supabase.from('batch_lignes').select('*'),
      supabase.from('recettes_cibles').select('*'),
      supabase.from('sacs').select('*'),
      supabase.from('matieres_premieres').select('*'),
      supabase.from('batch_consommations').select('*'),
    ])
    setData({
      batches:  b.data ?? [],
      lignes:   l.data ?? [],
      recettes: r.data ?? [],
      sacs:     s.data ?? [],
      mps:      m.data ?? [],
      conso:    c.data ?? [],
    })
    setLoading(false)
  }

  if (loading) {
    return <p className="text-sm text-gray-400 text-center py-12">Chargement…</p>
  }

  const { batches, lignes, recettes, sacs, mps, conso } = data
  const mpsMap = Object.fromEntries(mps.map(m => [m.id, m]))
  const lignesParBatch = lignes.reduce((acc, l) => {
    if (!acc[l.batch_id]) acc[l.batch_id] = []
    acc[l.batch_id].push(l)
    return acc
  }, {})

  const today = new Date()
  const startWeek = startOfWeek(today)
  const startMonth = startOfMonth(today)
  const startLastMonth = new Date(startMonth); startLastMonth.setMonth(startLastMonth.getMonth() - 1)
  const endLastMonth = startMonth

  const batchesAvecLignes = batches.map(b => ({
    ...b,
    lignes: lignesParBatch[b.id] ?? [],
    masseTotale: (lignesParBatch[b.id] ?? []).reduce((s, l) => s + (l.masse_totale_kg ?? 0), 0),
  }))
  const batchsParPeriode = (dateMin, dateMax) =>
    batchesAvecLignes.filter(b => {
      if (!b.date_creation) return false
      const d = new Date(b.date_creation)
      return d >= dateMin && (!dateMax || d < dateMax)
    })

  const dToday = new Date(today); dToday.setHours(0, 0, 0, 0)
  const dTomorrow = new Date(dToday); dTomorrow.setDate(dTomorrow.getDate() + 1)
  const batchsMois = batchsParPeriode(startMonth)
  const batchsMoisDernier = batchsParPeriode(startLastMonth, endLastMonth)

  // Production réelle = consommations déclarées jour par jour (batch_consommations),
  // pas la date de création des batchs (un batch créé lundi peut être consommé sur 2 semaines)
  const consoParPeriode = (dateMin, dateMax) =>
    conso.filter(c => {
      if (!c.date_consommation) return false
      const d = new Date(c.date_consommation)
      return d >= dateMin && (!dateMax || d < dateMax)
    })
  const consoJour = consoParPeriode(dToday, dTomorrow)
  const consoSemaine = consoParPeriode(startWeek)
  const consoMoisListe = consoParPeriode(startMonth)
  const consoMoisDernierListe = consoParPeriode(startLastMonth, endLastMonth)
  const sumConso = (cs) => cs.reduce((s, c) => s + (c.masse_kg ?? 0), 0)

  const tonnageJour = sumConso(consoJour)
  const tonnageSemaine = sumConso(consoSemaine)
  const tonnageMois = sumConso(consoMoisListe)
  const tonnageMoisDernier = sumConso(consoMoisDernierListe)
  const evolutionTonnage = tonnageMoisDernier > 0
    ? Math.round((tonnageMois - tonnageMoisDernier) / tonnageMoisDernier * 100)
    : null

  // Coût moyen €/t mois / mois précédent
  const coutMoyen = (bs) => {
    const totalKg  = bs.reduce((s, b) => s + b.masseTotale, 0)
    const totalEur = bs.reduce((s, b) => s + (b.cout_total_eur ?? 0), 0)
    return totalKg > 0 ? Math.round(totalEur / totalKg * 1000) : 0
  }
  const coutMois = coutMoyen(batchsMois)
  const coutMoisDernier = coutMoyen(batchsMoisDernier)
  const evolutionCout = coutMoisDernier > 0 ? Math.round((coutMois - coutMoisDernier) / coutMoisDernier * 100) : null

  // Batchs en cours
  const batchsEnCours = batchesAvecLignes.filter(b => b.statut === 'en_cours')
  const consoParBatch = conso.reduce((acc, c) => {
    acc[c.batch_id] = (acc[c.batch_id] ?? 0) + (c.masse_kg ?? 0)
    return acc
  }, {})

  // Stock par MP (dispo + partiel)
  const sacsActifs = sacs.filter(s => s.statut !== 'consomme')
  const stockParMp = sacsActifs.reduce((acc, s) => {
    acc[s.mp_id] = (acc[s.mp_id] ?? 0) + (s.masse_kg ?? 0)
    return acc
  }, {})
  const totalStockKg = Object.values(stockParMp).reduce((s, v) => s + v, 0)
  const nbMpEnStock = Object.keys(stockParMp).length

  // Alertes stock bas
  const alertesStock = mps
    .filter(mp => (mp.stock_mini_kg ?? 0) > 0)
    .map(mp => ({ mp, stock: stockParMp[mp.id] ?? 0 }))
    .filter(({ mp, stock }) => stock < mp.stock_mini_kg)
    .sort((a, b) => (a.stock / (a.mp.stock_mini_kg || 1)) - (b.stock / (b.mp.stock_mini_kg || 1)))

  // Top MP consommées ce mois
  const consoMois = batchsMois.reduce((acc, b) => {
    for (const l of b.lignes) {
      acc[l.mp_id] = (acc[l.mp_id] ?? 0) + (l.masse_totale_kg ?? 0)
    }
    return acc
  }, {})
  const topMps = Object.entries(consoMois)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([mpId, kg]) => ({ mp: mpsMap[mpId], kg }))

  // Recettes les plus produites ce mois
  const recetteCount = batchsMois.reduce((acc, b) => {
    if (!b.recette_id) return acc
    acc[b.recette_id] = (acc[b.recette_id] ?? 0) + b.masseTotale
    return acc
  }, {})
  const topRecettes = Object.entries(recetteCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([rid, kg]) => ({ recette: recettes.find(r => r.id === rid), kg }))

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Tableau de bord</h1>
        <p className="text-sm text-gray-500 mt-0.5">{today.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
      </div>

      {/* KPIs production (consommations déclarées en production) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Kpi label="Produit aujourd'hui" value={fmtKg(tonnageJour)} sub={`${consoJour.length} déclaration${consoJour.length !== 1 ? 's' : ''}`} />
        <Kpi label="Produit cette semaine" value={fmtKg(tonnageSemaine)} sub={`${consoSemaine.length} déclaration${consoSemaine.length !== 1 ? 's' : ''}`} />
        <Kpi
          label="Produit ce mois"
          value={fmtKg(tonnageMois)}
          sub={evolutionTonnage !== null ? `${evolutionTonnage > 0 ? '+' : ''}${evolutionTonnage}% vs M-1` : `${consoMoisListe.length} déclaration${consoMoisListe.length !== 1 ? 's' : ''}`}
          subColor={evolutionTonnage > 0 ? 'text-emerald-600' : evolutionTonnage < 0 ? 'text-red-600' : 'text-gray-500'}
        />
        <Kpi
          label="Coût moyen ce mois"
          value={coutMois > 0 ? `${coutMois} €/t` : '—'}
          sub={evolutionCout !== null ? `${evolutionCout > 0 ? '+' : ''}${evolutionCout}% vs M-1` : '—'}
          subColor={evolutionCout > 0 ? 'text-red-600' : evolutionCout < 0 ? 'text-emerald-600' : 'text-gray-500'}
        />
      </div>

      {/* Alertes stock */}
      {alertesStock.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-medium text-amber-900">⚠ Stock bas — {alertesStock.length} matière{alertesStock.length !== 1 ? 's' : ''}</h2>
            <Link to="/stock" className="text-xs text-amber-800 hover:underline">Voir le stock →</Link>
          </div>
          <div className="space-y-1">
            {alertesStock.slice(0, 5).map(({ mp, stock }) => (
              <div key={mp.id} className="flex justify-between text-sm">
                <span className="text-amber-900">{mp.nom}</span>
                <span className="font-medium tabular-nums text-amber-900">
                  {fmtKg(stock)} <span className="text-amber-600">/ mini {fmtKg(mp.stock_mini_kg)}</span>
                </span>
              </div>
            ))}
            {alertesStock.length > 5 && (
              <p className="text-xs text-amber-700 mt-1">+{alertesStock.length - 5} autre{alertesStock.length - 5 !== 1 ? 's' : ''}</p>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Batchs en cours */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-medium text-gray-900">Batchs en cours</h2>
            <Link to="/en-cours" className="text-xs text-gray-500 hover:text-gray-700">Détail →</Link>
          </div>
          {batchsEnCours.length === 0 ? (
            <p className="text-sm text-gray-400">Aucun batch en cours.</p>
          ) : (
            <div className="space-y-2">
              {batchsEnCours.map(b => {
                const conso = consoParBatch[b.id] ?? 0
                const pct = b.masseTotale > 0 ? Math.min(100, conso / b.masseTotale * 100) : 0
                const rc = recettes.find(r => r.id === b.recette_id)
                return (
                  <div key={b.id} className="border border-gray-100 rounded-lg p-3">
                    <div className="flex justify-between text-sm mb-1.5">
                      <span className="font-medium text-gray-900">{b.nom}</span>
                      <span className="text-gray-500 tabular-nums">{fmtKg(conso)} / {fmtKg(b.masseTotale)}</span>
                    </div>
                    <div className="w-full h-1.5 bg-gray-100 rounded overflow-hidden">
                      <div className="h-full bg-indigo-500" style={{ width: `${pct}%` }} />
                    </div>
                    {rc && <p className="text-xs text-gray-400 mt-1">{rc.nom}</p>}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Stock */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-medium text-gray-900">Stock</h2>
            <Link to="/stock" className="text-xs text-gray-500 hover:text-gray-700">Détail →</Link>
          </div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <p className="text-xs text-gray-500">Stock total</p>
              <p className="text-xl font-semibold text-gray-900">{fmtKg(totalStockKg)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">MP différentes</p>
              <p className="text-xl font-semibold text-gray-900">{nbMpEnStock}</p>
            </div>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-2">Top consommation ce mois</p>
            {topMps.length === 0 ? (
              <p className="text-sm text-gray-400">Aucune consommation ce mois.</p>
            ) : (
              <div className="space-y-1">
                {topMps.map(({ mp, kg }) => (
                  <div key={mp?.id} className="flex justify-between text-sm">
                    <span className="text-gray-700 truncate">{mp?.nom ?? '?'}</span>
                    <span className="text-gray-500 tabular-nums">{fmtKg(kg)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recettes du mois */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="font-medium text-gray-900 mb-3">Recettes produites ce mois</h2>
        {topRecettes.length === 0 ? (
          <p className="text-sm text-gray-400">Aucune production ce mois.</p>
        ) : (
          <div className="space-y-2">
            {topRecettes.map(({ recette, kg }) => (
              <div key={recette?.id} className="flex items-center justify-between">
                <span className="text-sm text-gray-700">{recette?.nom ?? '?'}</span>
                <div className="flex items-center gap-3">
                  <div className="w-32 h-1.5 bg-gray-100 rounded overflow-hidden">
                    <div
                      className="h-full bg-gray-700"
                      style={{ width: `${tonnageMois > 0 ? (kg / tonnageMois * 100) : 0}%` }}
                    />
                  </div>
                  <span className="text-sm font-medium tabular-nums w-20 text-right">{fmtKg(kg)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Kpi({ label, value, sub, subColor = 'text-gray-500' }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-2xl font-semibold text-gray-900">{value}</p>
      {sub && <p className={`text-xs mt-1 ${subColor}`}>{sub}</p>}
    </div>
  )
}
