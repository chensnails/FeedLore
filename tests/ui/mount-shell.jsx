import React from 'react';
import { createRoot } from 'react-dom/client';
import { TopBar, ReadProgress } from '../../src/shell/TopBar.jsx';

window.__mountTopBar = (el) => { const r = createRoot(el); r.render(<TopBar />); return r; };
window.__mountReadProgress = (el) => { const r = createRoot(el); r.render(<ReadProgress />); return r; };
