import './ui/styles.css';
import { App } from './ui/app';

const root = document.getElementById('root')!;
try {
  const app = new App(root);
  (window as unknown as { app: App }).app = app;
} catch (err) {
  console.error(err);
  root.innerHTML = `<div style="height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;color:#c8c8c8;font:14px/1.6 system-ui;text-align:center">
    <div><div style="font-size:16px;color:#e8e8e8;margin-bottom:8px">無法啟動編輯器</div>${(err as Error).message}<br>請使用支援 WebGL2 的瀏覽器（Chrome、Edge、Firefox、Safari 15 以上）。</div></div>`;
}
