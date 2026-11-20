import { createRoot } from 'react-dom/client';
import { AiView } from '../../src/ai/AiView.tsx';

window.__mountAi = (el) => {
  const r = createRoot(el);
  r.render(<AiView />);
  return r;
};
