// Barre de composition visuelle d'une matière première
export default function CompositionBar({ mp }) {
  const sable = mp.pct_sable ?? 0
  const plast = 100 - sable

  const segs = [
    { pct: (mp.pct_pp ?? 0) * plast / 100,  color: 'bg-blue-400',   label: 'PP' },
    { pct: (mp.pct_pe ?? 0) * plast / 100,  color: 'bg-emerald-400', label: 'PE' },
    { pct: (mp.pct_alu ?? 0) * plast / 100, color: 'bg-amber-400',  label: 'Alu' },
    { pct: sable,                             color: 'bg-gray-300',   label: 'Sable' },
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
