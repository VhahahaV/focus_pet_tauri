import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyStoredDocumentTheme } from './themes'

applyStoredDocumentTheme()

const initialWidgetMode = new URLSearchParams(window.location.search).get("widget")

if (initialWidgetMode) {
  document.documentElement.dataset.focusPetSurface = "widget"
  document.body.dataset.focusPetSurface = "widget"
  document.documentElement.dataset.focusPetWidget = initialWidgetMode
  document.body.dataset.focusPetWidget = initialWidgetMode
}

if (initialWidgetMode) {
  const transparentSurface = (element: HTMLElement) => {
    element.style.background = "transparent"
    element.style.backgroundColor = "transparent"
    element.style.backgroundImage = "none"
    element.style.minWidth = "0"
    element.style.minHeight = "0"
  }
  transparentSurface(document.documentElement)
  transparentSurface(document.body)
  transparentSurface(document.getElementById("root")!)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
