/** 名单页入口（console.html）。只由 Worker 在密钥 ADMIN_PATH 的地址下提供（ADMIN_PATH、ADMIN_PASSWORD 任一没配好时整体 404）。 */
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
