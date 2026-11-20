import { createRoot } from 'react-dom/client';
import { QueryProvider } from '../../src/kernel/QueryProvider.tsx';
import { Overlays } from '../../src/ui/Overlays.tsx';
import { ScrollTop } from '../../src/ui/ScrollTop.tsx';

window.__mountOverlays = (el) => {
  const r = createRoot(el);
  r.render(
    <QueryProvider>
      <Overlays />
    </QueryProvider>,
  );
  return r;
};
window.__mountScrollTop = (el) => {
  const r = createRoot(el);
  r.render(
    <QueryProvider>
      <ScrollTop />
    </QueryProvider>,
  );
  return r;
};
