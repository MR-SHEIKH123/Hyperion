import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AppProviders } from './app/providers';
import { AppRouter } from './app/router';
import './design-system/foundation.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Hyperion could not find its application root.');

createRoot(root).render(
  <StrictMode>
    <AppProviders>
      <AppRouter />
    </AppProviders>
  </StrictMode>,
);
