// Bundled rather than fetched, so the Android app has its typeface with no connection.
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@/global.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from '@/App';
import { startUpdateChecks } from '@/lib/updates/updater';

// Before the first render, so a waiting update is found as early as possible.
startUpdateChecks();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
