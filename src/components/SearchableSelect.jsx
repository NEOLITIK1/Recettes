import { useState, useRef, useEffect } from 'react'

// Sélecteur avec barre de recherche.
// options : [{ value, label }] · value : valeur sélectionnée · onChange(value)
export default function SearchableSelect({ options, value, onChange, placeholder = 'Sélectionner…', className = '' }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef(null)
  const selected = options.find(o => o.value === value)

  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const q = query.trim().toLowerCase()
  const filtered = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => { setOpen(o => !o); setQuery('') }}
        className="w-full text-left text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-gray-400 flex items-center justify-between gap-2"
      >
        <span className={selected ? 'text-gray-900 truncate' : 'text-gray-400'}>{selected ? selected.label : placeholder}</span>
        <span className="text-gray-400 text-xs flex-shrink-0">▾</span>
      </button>
      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 flex flex-col overflow-hidden">
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Rechercher…"
            className="text-sm border-b border-gray-100 px-3 py-2 focus:outline-none"
          />
          <div className="overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-xs text-gray-400 px-3 py-2">Aucun résultat</p>
            ) : filtered.map(o => (
              <button
                type="button"
                key={o.value}
                onClick={() => { onChange(o.value); setOpen(false) }}
                className={`w-full text-left text-sm px-3 py-2 hover:bg-gray-50 ${o.value === value ? 'bg-gray-100 font-medium' : ''}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
