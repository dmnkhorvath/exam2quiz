import { Routes, Route, Navigate } from "react-router-dom";

// Placeholder pages — will be implemented in the admin UI task
function Dashboard() {
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold">Exams2Quiz Admin</h1>
      <p className="mt-2 text-gray-500">Dashboard — coming soon</p>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
