import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { RANGEES, PROFONDEUR_MAX, MAX_PILE, construirePlan, statsPlan } from '../lib/plan.js'
import { mpDuSac } from '../lib/calculs.js'
import { FicheMp } from './TooltipMp.jsx'

// Récap chiffré des places libres (page Stock et tableau de bord)
export function RecapPlaces({ stats }) {
  return (
    <div>
      <p className="text-sm text-gray-700">
        <span className="text-2xl font-semibold text-gray-900 tabular-nums">{stats.libres}</span>
        <span className="text-gray-400"> / {stats.total}</span> places libres
      </p>
      <p className="text-xs text-gray-500 mt-1">
        Stockable : <strong className="text-gray-900">{stats.grands} grand{stats.grands > 1 ? 's' : ''}</strong> ou{' '}
        <strong className="text-gray-900">{stats.petits} petit{stats.petits > 1 ? 's' : ''}</strong>
        {stats.complements > 0 && <> (dont {stats.complements} pour compléter des piles)</>}
      </p>
      {stats.horsPlan > 0 && (
        <p className="text-xs text-amber-700 mt-1">
          {stats.horsPlan} sac{stats.horsPlan > 1 ? 's' : ''} en stock hors plan, non compté{stats.horsPlan > 1 ? 's' : ''} ici.
        </p>
      )}
    </div>
  )
}

// Fenêtre au survol d'une case : composition de chaque sac (le haut de pile en premier)
const LARGEUR_FICHE = 224
function FenetreCase({ lieu, sacs, rect, mpById, aSortir }) {
  const largeur = sacs.length * LARGEUR_FICHE
  const enBas = rect.bottom + 260 < window.innerHeight
  const style = {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - largeur - 8)),
    maxWidth: 'calc(100vw - 16px)',
    ...(enBas ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }),
  }
  return (
    <div style={style} className="fixed z-50 flex bg-white border border-gray-200 rounded-lg shadow-lg divide-x divide-gray-100 pointer-events-none">
      {[...sacs].reverse().map(s => {
        const mp = mpDuSac(mpById[s.mp_id], s)
        return (
          <div key={s.id} style={{ width: LARGEUR_FICHE }} className="p-3 min-w-0">
            <p className="text-[11px] text-gray-400 mb-1">
              {lieu}{sacs.length > 1 ? ` · niveau ${s.niveau}` : ''} · {(s.masse_kg ?? 0) > 0 ? `${Math.round(s.masse_kg)} kg` : 'vidé'}
              {aSortir.has(s.id) ? ' · à sortir' : ''}
            </p>
            {mp ? <FicheMp mp={mp} /> : <p className="text-xs text-gray-500">{s.mp_id}</p>}
          </div>
        )
      })}
    </div>
  )
}

// Carte du stock. Grand sac = case blanche, petits = nombre de sacs, gris = à sortir.
export default function PlanStock({ sacs, mpById, aSortir, onCase }) {
  const plan = construirePlan(sacs)
  const stats = statsPlan(sacs)
  const libresParRangee = Object.fromEntries(stats.parRangee.map(r => [r.code, r]))

  // Case survolée : { lieu, sacs, rect }. La fenêtre est affichée hors de la carte
  // (qui défile horizontalement et la couperait).
  const [survol, setSurvol] = useState(null)
  useEffect(() => {
    if (!survol) return
    const fermer = () => setSurvol(null)
    window.addEventListener('scroll', fermer, true)
    return () => window.removeEventListener('scroll', fermer, true)
  }, [survol])

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h2 className="font-medium text-gray-900">Plan de stockage</h2>
          <p className="text-xs text-gray-400">Cliquez sur une case pour voir son contenu ou y placer un sac</p>
        </div>
        <RecapPlaces stats={stats} />
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${RANGEES.length}, minmax(0, 1fr))` }}>
            {RANGEES.map(r => <div key={r.code} className="text-center text-sm font-semibold text-gray-700">{r.code}</div>)}
          </div>
          <p className="text-center text-[10px] tracking-widest text-gray-400 my-1">FOND (MUR)</p>
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${RANGEES.length}, minmax(0, 1fr))` }}>
            {Array.from({ length: PROFONDEUR_MAX }, (_, i) => RANGEES.map(r => {
              if (i >= r.places) return <div key={r.code + i} />
              const c = plan[r.code][i]
              const reserve = c?.sacs.some(s => aSortir.has(s.id))
              return (
                <button
                  key={r.code + i}
                  type="button"
                  aria-label={`${r.code}${i + 1}${c ? '' : ' — libre'}`}
                  onMouseEnter={e => setSurvol(c ? { lieu: `${r.code}${i + 1}`, sacs: c.sacs, rect: e.currentTarget.getBoundingClientRect() } : null)}
                  onMouseLeave={() => setSurvol(null)}
                  onClick={() => { setSurvol(null); onCase(r.code, c) }}
                  className={`relative h-12 rounded border text-base font-semibold transition-colors ${
                    !c ? 'border-dashed border-gray-300 text-transparent hover:border-gray-500'
                    : reserve ? 'border-2 border-gray-900 bg-gray-400 text-gray-900 hover:bg-gray-300'
                    : 'border-gray-500 bg-white text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  <span className={`absolute top-0.5 left-1 text-[9px] font-normal ${!c ? 'text-gray-300' : reserve ? 'text-gray-900' : 'text-gray-500'}`}>{r.code}{i + 1}</span>
                  {c?.taille === 'petit' ? c.sacs.length : ''}
                </button>
              )
            }))}
          </div>
          <p className="text-center text-[10px] tracking-widest text-gray-400 my-1">ALLÉE</p>
          <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${RANGEES.length}, minmax(0, 1fr))` }}>
            {RANGEES.map(r => {
              const l = libresParRangee[r.code]
              return (
                <div key={r.code} className="text-center text-[11px] leading-tight" title={`${l.libres} place(s) libre(s) sur ${r.places}${l.complements ? `, ${l.complements} petit(s) en complément de pile` : ''}`}>
                  <span className={l.libres > 0 ? 'text-emerald-700 font-semibold' : 'text-gray-300'}>{l.libres}</span>
                  {l.complements > 0 && <span className="text-gray-400"> +{l.complements}</span>}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="flex gap-x-5 gap-y-1 flex-wrap mt-3 text-xs text-gray-500">
        <span><span className="inline-block w-4 h-3 border border-gray-500 bg-white rounded-sm align-middle mr-1" />grand big bag</span>
        <span><span className="inline-block w-4 text-center border border-gray-500 bg-white rounded-sm mr-1 text-[10px] font-semibold text-gray-900">2</span>petits empilés ({MAX_PILE} max)</span>
        <span><span className="inline-block w-4 h-3 border-2 border-gray-900 bg-gray-400 rounded-sm align-middle mr-1" />à sortir pour un batch</span>
        <span><span className="inline-block w-4 h-3 border border-dashed border-gray-300 rounded-sm align-middle mr-1" />libre</span>
        <span>En bas : places libres, +n = petits pouvant compléter une pile</span>
      </div>

      {survol && createPortal(<FenetreCase {...survol} mpById={mpById} aSortir={aSortir} />, document.body)}
    </div>
  )
}
