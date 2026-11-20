import { createRoot } from 'react-dom/client';
import { AiView } from '../../src/ai/AiView.tsx';
import { QueryProvider } from '../../src/kernel/QueryProvider.tsx';

window.__mountAi = (el) => {
  const r = createRoot(el);
  r.render(
    <QueryProvider>
      <AiView />
    </QueryProvider>,
  );
  return r;
};
