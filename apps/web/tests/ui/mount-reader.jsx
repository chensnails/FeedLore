import { createRoot } from 'react-dom/client';
import { ReaderView } from '../../src/views/ReaderView.tsx';

window.__mountReader = (el) => {
  const r = createRoot(el);
  r.render(<ReaderView />);
  return r;
};
