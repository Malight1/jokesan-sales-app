import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './lib/AuthContext';
import { ToastProvider } from './lib/ToastContext';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import { Loading } from './components/DataStates';
import './styles/global.scss';

// Login is the first thing every visitor sees, so it stays in the main bundle.
// Everything behind auth is split per route: a cashier who only opens the POS
// shouldn't have to download Recharts, the CSV importer and the OCR engine
// before the till will open.
import Login from './pages/Login';

const AcceptInvite = lazy(() => import('./pages/AcceptInvite'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Sales = lazy(() => import('./pages/Sales'));
const Purchases = lazy(() => import('./pages/Purchases'));
const Inventory = lazy(() => import('./pages/Inventory'));
const Production = lazy(() => import('./pages/Production'));
const FinishedGoods = lazy(() => import('./pages/FinishedGoods'));
const Expenses = lazy(() => import('./pages/Expenses'));
const Customers = lazy(() => import('./pages/Customers'));
const Suppliers = lazy(() => import('./pages/Suppliers'));
const StockMovement = lazy(() => import('./pages/StockMovement'));
const Reports = lazy(() => import('./pages/Reports'));
const StockAlerts = lazy(() => import('./pages/StockAlerts'));
const Insights = lazy(() => import('./pages/Insights'));
const Settings = lazy(() => import('./pages/Settings'));
const POS = lazy(() => import('./pages/POS'));
const ImportData = lazy(() => import('./pages/ImportData'));
const SuperAdmin = lazy(() => import('./pages/SuperAdmin'));
const MatchPayment = lazy(() => import('./pages/MatchPayment'));

export default function App() {
  return (
    <ToastProvider>
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={<Loading label="Loading…" />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/accept-invite" element={<AcceptInvite />} />
            <Route
              path="/*"
              element={
                <ProtectedRoute>
                  <Layout>
                    {/* Inner boundary so the sidebar and topbar stay on screen
                        while the next page's chunk downloads. */}
                    <Suspense fallback={<Loading label="Loading…" />}>
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
                    </Suspense>
                  </Layout>
                </ProtectedRoute>
              }
            />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
    </ToastProvider>
  );
}
