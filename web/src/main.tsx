import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './theme.css';

// Chrome < 84 ignores `gap` on flex containers, but there `gap` still parses (it is the
// grid alias), so reading computed style would be a false positive. Measure layout instead:
// two 10px items in a shrink-to-fit flex row span 26px only when the gap really applies.
const probe = document.createElement('div');
probe.style.cssText = 'position:absolute;visibility:hidden;display:flex;gap:6px;';
const a = document.createElement('i');
const b = document.createElement('i');
for (const el of [a, b]) el.style.cssText = 'width:10px;height:10px;';
probe.append(a, b);
document.body.appendChild(probe);
const flexGapOk = Math.round(probe.getBoundingClientRect().width) === 26;
probe.remove();
if (!flexGapOk) document.body.classList.add('no-flexgap');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
