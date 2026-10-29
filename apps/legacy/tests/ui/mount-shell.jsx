import React from 'react';
import { createRoot } from 'react-dom/client';
import { TopBar } from '../../src/shell/TopBar.jsx';

window.__mountTopBar = (el) => { const r = createRoot(el); r.render(<TopBar />); return r; };
