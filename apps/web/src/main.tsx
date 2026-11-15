import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Delete rooms of events that ended more than 24 h ago, even if the disband was never seen.
setTimeout(() => {
  void import('./rooms/client').then((m) => m.purgeExpiredRooms()).catch(() => {});
}, 3000);
