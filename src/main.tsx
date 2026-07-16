import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const initialWidgetMode = new URLSearchParams(window.location.search).get("widget")

if (initialWidgetMode) {
  document.documentElement.dataset.focusPetSurface = "widget"
  document.body.dataset.focusPetSurface = "widget"
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
