import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import Matieres from './pages/Matieres.jsx'
import Recettes from './pages/Recettes.jsx'
import Stock from './pages/Stock.jsx'
import Optimiseur from './pages/Optimiseur.jsx'
import ManuelBatch from './pages/ManuelBatch.jsx'
import BatchEnCours from './pages/BatchEnCours.jsx'
import Historique from './pages/Historique.jsx'

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/matieres" replace />} />
        <Route path="/matieres" element={<Matieres />} />
        <Route path="/recettes" element={<Recettes />} />
        <Route path="/stock" element={<Stock />} />
        <Route path="/optimiseur" element={<Optimiseur />} />
        <Route path="/manuel" element={<ManuelBatch />} />
        <Route path="/en-cours" element={<BatchEnCours />} />
        <Route path="/historique" element={<Historique />} />
      </Routes>
    </Layout>
  )
}
