import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles/tokens.css'
import './styles/app.css'
import './styles/pages.css'
import './styles/stage.css'
import './styles/logs.css'

const root = document.getElementById('root')
if (root === null) throw new Error('chat-web: missing #root element')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
