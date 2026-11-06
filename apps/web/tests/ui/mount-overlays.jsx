import React from 'react';
import { createRoot } from 'react-dom/client';
import { Overlays } from '../../src/ui/Overlays.jsx';
import { ScrollTop } from '../../src/ui/ScrollTop.jsx';

window.__mountOverlays = (el) => { const r = createRoot(el); r.render(<Overlays />); return r; };
window.__mountScrollTop = (el) => { const r = createRoot(el); r.render(<ScrollTop />); return r; };
