import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import Layout from "./components/Layout";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import TenantsPage from "./pages/TenantsPage";
import UsersPage from "./pages/UsersPage";
import PipelinesPage from "./pages/PipelinesPage";
import CategoriesPage from "./pages/CategoriesPage";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequireRole({
  children,
  roles,
}: {
  children: React.ReactNode;
  roles: string[];
}) {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/" replace /> : <LoginPage />}
      />

      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route
          path="/tenants"
          element={
            <RequireRole roles={["SUPER_ADMIN"]}>
              <TenantsPage />
            </RequireRole>
          }
        />
        <Route
          path="/users"
          element={
            <RequireRole roles={["SUPER_ADMIN", "TENANT_ADMIN"]}>
              <UsersPage />
            </RequireRole>
          }
        />
        <Route path="/pipelines" element={<PipelinesPage />} />
        <Route
          path="/categories"
          element={
            <RequireRole roles={["SUPER_ADMIN", "TENANT_ADMIN"]}>
              <CategoriesPage />
            </RequireRole>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
