import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReaderView } from '../../src/views/ReaderView.jsx';
window.__mountReader = (el) => { const r = createRoot(el); r.render(<ReaderView />); return r; };
