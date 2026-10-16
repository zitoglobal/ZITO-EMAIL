import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import '@fontsource-variable/instrument-sans';
import './styles.css';
import { registerServiceWorker } from './pushClient.js';

createRoot(document.getElementById('root')).render(<App />);
registerServiceWorker();
