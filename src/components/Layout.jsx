import { NavLink } from 'react-router-dom'

const NAV = [
  { to: '/matieres',   label: 'Matières premières',  icon: '🧪' },
  { to: '/recettes',   label: 'Recettes cibles',      icon: '🎯' },
  { to: '/stock',      label: 'Stock de sacs',         icon: '📦' },
  { to: '/optimiseur', label: 'Optimiseur',            icon: '⚙️' },
  { to: '/manuel',     label: 'Composition manuelle',  icon: '✏️' },
  { to: '/en-cours',   label: 'Batchs en cours',       icon: '🔄' },
  { to: '/historique', label: 'Historique',            icon: '📋' },
]

export default function Layout({ children }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-56 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-4 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <span className="text-green-600 font-semibold text-sm">●</span>
            <span className="font-semibold text-gray-900">NEOLITIK</span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">Production</p>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {NAV.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-gray-100 text-gray-900 font-medium'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`
              }
            >
              <span>{icon}</span>
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto bg-gray-50">
        <div className="max-w-6xl mx-auto px-6 py-6">
          {children}
        </div>
      </main>
    </div>
  )
}
