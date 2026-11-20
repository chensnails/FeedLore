import { createRoot } from 'react-dom/client';
import { QueryProvider } from '../../src/kernel/QueryProvider.tsx';
import { CardsView } from '../../src/views/CardsView.tsx';

window.__mountCards = (el) => {
  const r = createRoot(el);
  r.render(
    <QueryProvider>
      <CardsView />
    </QueryProvider>,
  );
  return r;
};
