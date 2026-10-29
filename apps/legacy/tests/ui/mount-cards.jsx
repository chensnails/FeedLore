import React from 'react';
import { createRoot } from 'react-dom/client';
import { CardsView } from '../../src/views/CardsView.jsx';
window.__mountCards = (el) => { const r = createRoot(el); r.render(<CardsView />); return r; };
