// Barre de recherche pour filtrer une liste
export default function BarreRecherche({ value, onChange, placeholder = 'Rechercher…', className = '' }) {
  return (
    <div className={`relative ${className}`}>
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">🔍</span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full text-sm border border-gray-200 rounded-lg pl-9 pr-8 py-2 bg-white focus:outline-none focus:border-gray-400"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Effacer la recherche"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-lg leading-none px-1"
        >
          ×
        </button>
      )}
    </div>
  )
}
