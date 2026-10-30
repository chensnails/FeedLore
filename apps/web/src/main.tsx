import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { queryClient } from './lib/query';
import './style.css';

const el = document.getElementById('root');
if (!el) throw new Error('缺少 #root 挂载点');

createRoot(el).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
