import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './theme.css';

// Chrome < 84 only supports `gap` on grid, not flex. Detect once and flip
// .no-flexgap margins in theme.css (see its last section) as fallback.
const probe = document.createElement('div');
probe.style.cssText = 'display:flex;gap:3px;';
document.body.appendChild(probe);
const flexGapOk = getComputedStyle(probe).gap === '3px';
probe.remove();
if (!flexGapOk) document.body.classList.add('no-flexgap');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
