import { createRoot } from 'react-dom/client';
import { Overlays } from '../../src/ui/Overlays.tsx';
import { ScrollTop } from '../../src/ui/ScrollTop.tsx';

window.__mountOverlays = (el) => {
  const r = createRoot(el);
  r.render(<Overlays />);
  return r;
};
window.__mountScrollTop = (el) => {
  const r = createRoot(el);
  r.render(<ScrollTop />);
  return r;
};
