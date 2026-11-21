/**
 * Standalone dev harness: renders the settings page in a plain browser page, so
 * the UI can be iterated on without booting a host.
 *
 * Run `npm run dev:ui` and open the printed URL. This file is not part of the
 * published bundle — `main.tsx` is the only entry the build reads.
 */
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const container = document.getElementById('root')
if (container === null) throw new Error('dev harness: #root is missing')
createRoot(container).render(<App />)
