import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell, RequireAuth } from './components/AppShell';
import { AuthCallback, ForgotPassword, ResetPassword, SignIn, SignUp } from './pages/Auth';
import { Onboarding } from './pages/Onboarding';
import { Dashboard } from './pages/Dashboard';
import { Integrations } from './pages/Integrations';
import { Teams } from './pages/Teams';
import { Account } from './pages/Account';
import { Contacts } from './pages/Contacts';
import { Projects } from './pages/Projects';
import { Capture } from './pages/Capture';
import { Meetings } from './pages/Meetings';
import { Meeting } from './pages/Meeting';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<SignIn />} />
      <Route path="/signin" element={<SignIn />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/forgot" element={<ForgotPassword />} />
      <Route path="/reset" element={<ResetPassword />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/onboarding" element={<RequireAuth><Onboarding /></RequireAuth>} />
      <Route path="/app" element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<Dashboard />} />
        <Route path="capture" element={<Capture />} />
        <Route path="meetings" element={<Meetings />} />
        <Route path="meetings/:id" element={<Meeting />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="projects" element={<Projects />} />
        <Route path="integrations" element={<Integrations />} />
        <Route path="teams" element={<Teams />} />
        <Route path="account" element={<Account />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
