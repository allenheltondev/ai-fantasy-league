import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { ToastProvider } from '@readysetcloud/ui';
import { configureAuth } from '@readysetcloud/ui/auth';
import '@readysetcloud/ui/styles.css';
import '@readysetcloud/ui/fonts.css';
import './index.css';
import { App } from './App';
import { toAuthConfig } from './auth/authConfig';
import { ConfigContext } from './config/ConfigContext';
import { loadRuntimeConfig } from './config/runtimeConfig';

async function bootstrap(root: HTMLElement) {
  const auth = await loadRuntimeConfig();
  configureAuth(auth ? toAuthConfig(auth) : null);

  createRoot(root).render(
    <StrictMode>
      <ConfigContext.Provider value={{ auth }}>
        <ToastProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ToastProvider>
      </ConfigContext.Provider>
    </StrictMode>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');
void bootstrap(root);
