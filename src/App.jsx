import { Navigate, Route, Routes } from 'react-router-dom'
import ToolPage from './pages/ToolPage.jsx'

function App() {
  return (
    <Routes>
      <Route path="/" element={<ToolPage />} />
      <Route path="/tool" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
