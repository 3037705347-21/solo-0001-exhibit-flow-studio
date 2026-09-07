import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { WorkspaceProvider } from './state/WorkspaceContext';
import './styles/global.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WorkspaceProvider>
      <App />
    </WorkspaceProvider>
  </StrictMode>,
);
