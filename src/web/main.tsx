import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.js';
import { CurrencyProvider } from './currencyContext.js';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      {/* 显示币种与站点汇率的共享只读源：模型广场、路由通道、使用日志必须同源，
          否则同一个价会在三处显示成三种口径。 */}
      <CurrencyProvider>
        <App />
      </CurrencyProvider>
    </BrowserRouter>
  </React.StrictMode>
);
