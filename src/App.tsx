import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './lib/AuthContext';
import { ToastProvider } from './lib/ToastContext';
import ProtectedRoute from './components/ProtectedRoute';
import PublicGate from './components/PublicGate';
import Layout from './components/Layout';
import { Loading } from './components/DataStates';
import './styles/global.scss';

// Login is the first thing every visitor sees, so it stays in the main bundle.
// Everything behind auth is split per route: a cashier who only opens the POS
// shouldn't have to download Recharts, the CSV importer and the OCR engine
// before the till will open.
import Login from './pages/Login';

// The public marketing site. Each page is its own lazy chunk, same as every
// authenticated route below — a logged-out visitor's first paint shouldn't
// pull in the app bundle, and a logged-in dashboard load shouldn't pull in
// marketing copy either.
const Home = lazy(() => import('./marketing/pages/Home'));
const Product = lazy(() => import('./marketing/pages/Product'));
const Pricing = lazy(() => import('./marketing/pages/Pricing'));
const Faq = lazy(() => import('./marketing/pages/Faq'));

const AcceptInvite = lazy(() => import('./pages/AcceptInvite'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Sales = lazy(() => import('./pages/Sales'));
const Quotes = lazy(() => import('./pages/Quotes'));
const Deliveries = lazy(() => import('./pages/Deliveries'));
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
const Profile = lazy(() => import('./pages/Profile'));
const Transfers = lazy(() => import('./pages/Transfers'));
const Batches = lazy(() => import('./pages/Batches'));
const Audit = lazy(() => import('./pages/Audit'));
const Assistant = lazy(() => import('./pages/Assistant'));
// Development-only design preview of the three role dashboards (sample
// data, no sign-in). The constant condition is resolved at build time, so
// the route and its chunk are dropped from production builds.
const DashboardPreview = process.env.NODE_ENV === 'development'
  ? lazy(() => import('./dev/DashboardPreview'))
  : null;

export default function App() {
  return (
    <ToastProvider>
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={<Loading label="Loading…" />}>
          <Routes>
            <Route element={<PublicGate />}>
              <Route path="/" element={<Home />} />
              <Route path="/product" element={<Product />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/faq" element={<Faq />} />
            </Route>
            <Route path="/login" element={<Login />} />
            <Route path="/accept-invite" element={<AcceptInvite />} />
            {DashboardPreview && <Route path="/__dev/dashboards" element={<DashboardPreview />} />}
            <Route
              path="/*"
              element={
                <ProtectedRoute>
                  <Layout>
                    {/* Inner boundary so the sidebar and topbar stay on screen
                        while the next page's chunk downloads. */}
                    <Suspense fallback={<Loading label="Loading…" />}>
                      <Routes>
                        <Route path="/dashboard" element={<Dashboard />} />
                        <Route path="/sales" element={<Sales />} />
                        <Route path="/quotes" element={<Quotes />} />
                        <Route path="/deliveries" element={<Deliveries />} />
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
                        <Route path="/transfers" element={<Transfers />} />
                        <Route path="/batches" element={<Batches />} />
                        <Route path="/profile" element={<Profile />} />
                        <Route path="/settings" element={<Settings />} />
                        <Route path="/audit" element={<Audit />} />
                        <Route path="/assistant" element={<Assistant />} />
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
