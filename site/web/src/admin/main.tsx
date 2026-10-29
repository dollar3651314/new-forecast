/** 名单页入口（admin.html，地址 /admin）。只有 ADMIN_PASSWORD 开通时 Worker 才给这一页（没开通 404）。 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './admin.css';
import { AdminApp } from './AdminApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
