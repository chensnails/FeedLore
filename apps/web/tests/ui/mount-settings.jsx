import React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsModal } from '../../src/settings/SettingsModal.jsx';
window.__mount = (el) => { createRoot(el).render(<SettingsModal />); };
