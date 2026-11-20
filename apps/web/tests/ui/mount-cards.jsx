import { createRoot } from 'react-dom/client';
import { CardsView } from '../../src/views/CardsView.tsx';

window.__mountCards = (el) => {
  const r = createRoot(el);
  r.render(<CardsView />);
  return r;
};
