import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router.js';
import { Toaster } from './components/Toaster.js';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('No #root element found');

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
    <Toaster />
  </StrictMode>,
);
