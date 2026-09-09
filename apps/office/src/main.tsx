import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OfficeApp } from './office-app.js';
import { createOfficeRouter } from './router.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Office root element is missing.');

createRoot(root).render(
  <StrictMode>
    <OfficeApp router={createOfficeRouter()} />
  </StrictMode>
);
