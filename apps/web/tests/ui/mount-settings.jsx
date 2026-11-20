import { createRoot } from 'react-dom/client';
import { QueryProvider } from '../../src/kernel/QueryProvider.tsx';
import { SettingsModal } from '../../src/settings/SettingsModal.tsx';

window.__mount = (el) => {
  createRoot(el).render(
    <QueryProvider>
      <SettingsModal />
    </QueryProvider>,
  );
};
