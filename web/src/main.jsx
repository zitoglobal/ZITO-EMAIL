import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AppErrorBoundary from './components/AppErrorBoundary.jsx';
import '@fontsource-variable/instrument-sans';
import './styles.css';
import { registerServiceWorker } from './pushClient.js';
import { applyPlatformClasses, bindVisualViewport } from './platform.js';

applyPlatformClasses();
bindVisualViewport();

createRoot(document.getElementById('root')).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
);
registerServiceWorker();
