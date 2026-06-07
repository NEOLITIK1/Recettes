// Barre de composition visuelle d'une matière première
export default function CompositionBar({ mp }) {
  const sable     = mp.pct_sable ?? 0
  const chargeMin = mp.pct_charge_minerale ?? 0
  const nonPlast  = sable + chargeMin
  const plast     = Math.max(0, 100 - nonPlast)

  const segs = [
    { pct: (mp.pct_pp ?? 0)                 * plast / 100, color: 'bg-blue-400',    label: 'PP' },
    { pct: (mp.pct_pe ?? 0)                 * plast / 100, color: 'bg-emerald-400', label: 'PE' },
    { pct: (mp.pct_alu ?? 0)                * plast / 100, color: 'bg-amber-400',   label: 'Alu' },
    { pct: (mp.pct_autres_plastiques ?? 0)  * plast / 100, color: 'bg-purple-400',  label: 'Autres plast.' },
    { pct: sable,     color: 'bg-stone-300', label: 'Sable (EcoLithe)' },
    { pct: chargeMin, color: 'bg-stone-600', label: 'Charge minérale' },
  ].filter(s => s.pct > 0)

  return (
    <div className="flex h-2 w-28 rounded overflow-hidden gap-px bg-gray-100">
      {segs.map((s, i) => (
        <div
          key={i}
          className={`h-full ${s.color}`}
          style={{ width: `${s.pct}%` }}
          title={`${s.label}: ${s.pct.toFixed(1)}%`}
        />
      ))}
    </div>
  )
}
