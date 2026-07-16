import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './lib/AuthContext';
import { ToastProvider } from './lib/ToastContext';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import Login from './pages/Login';
import AcceptInvite from './pages/AcceptInvite';
import Dashboard from './pages/Dashboard';
import Sales from './pages/Sales';
import Purchases from './pages/Purchases';
import Inventory from './pages/Inventory';
import Production from './pages/Production';
import FinishedGoods from './pages/FinishedGoods';
import Expenses from './pages/Expenses';
import Customers from './pages/Customers';
import Suppliers from './pages/Suppliers';
import StockMovement from './pages/StockMovement';
import Reports from './pages/Reports';
import StockAlerts from './pages/StockAlerts';
import Insights from './pages/Insights';
import Settings from './pages/Settings';
import POS from './pages/POS';
import ImportData from './pages/ImportData';
import SuperAdmin from './pages/SuperAdmin';
import MatchPayment from './pages/MatchPayment';
import './styles/global.scss';

export default function App() {
  return (
    <ToastProvider>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/accept-invite" element={<AcceptInvite />} />
          <Route
            path="/*"
            element={
              <ProtectedRoute>
                <Layout>
                  <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/sales" element={<Sales />} />
                    <Route path="/purchases" element={<Purchases />} />
                    <Route path="/inventory" element={<Inventory />} />
                    <Route path="/production" element={<Production />} />
                    <Route path="/finished-goods" element={<FinishedGoods />} />
                    <Route path="/expenses" element={<Expenses />} />
                    <Route path="/customers" element={<Customers />} />
                    <Route path="/suppliers" element={<Suppliers />} />
                    <Route path="/stock-movement" element={<StockMovement />} />
                    <Route path="/reports" element={<Reports />} />
                    <Route path="/stock-alerts" element={<StockAlerts />} />
                    <Route path="/insights" element={<Insights />} />
                    <Route path="/pos" element={<POS />} />
                    <Route path="/import" element={<ImportData />} />
                    <Route path="/platform" element={<SuperAdmin />} />
                    <Route path="/match-payment" element={<MatchPayment />} />
                    <Route path="/settings" element={<Settings />} />
                  </Routes>
                </Layout>
              </ProtectedRoute>
            }
          />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
    </ToastProvider>
  );
}
