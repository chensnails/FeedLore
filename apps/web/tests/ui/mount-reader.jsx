import { createRoot } from 'react-dom/client';
import { QueryProvider } from '../../src/kernel/QueryProvider.tsx';
import { ReaderView } from '../../src/views/ReaderView.tsx';

window.__mountReader = (el) => {
  const r = createRoot(el);
  r.render(
    <QueryProvider>
      <ReaderView />
    </QueryProvider>,
  );
  return r;
};
