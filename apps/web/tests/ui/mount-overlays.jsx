import React from 'react';
import { createRoot } from 'react-dom/client';
import { Overlays } from '../../src/ui/Overlays.jsx';

window.__mountOverlays = (el) => { const r = createRoot(el); r.render(<Overlays />); return r; };
