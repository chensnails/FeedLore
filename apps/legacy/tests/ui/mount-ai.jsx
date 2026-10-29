import React from 'react';
import { createRoot } from 'react-dom/client';
import { AiView } from '../../src/ai/AiView.jsx';
window.__mountAi = (el) => { const r = createRoot(el); r.render(<AiView />); return r; };
