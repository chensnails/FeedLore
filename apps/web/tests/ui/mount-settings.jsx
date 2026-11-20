import { createRoot } from 'react-dom/client';
import { SettingsModal } from '../../src/settings/SettingsModal.tsx';

window.__mount = (el) => {
  createRoot(el).render(<SettingsModal />);
};
