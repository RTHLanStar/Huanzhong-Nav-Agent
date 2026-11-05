import { Outlet } from '@modern-js/runtime/router';
import { AppProviders } from '../components/AppProviders';
import '@mantine/core/styles.css';
import '../styles/global.css';

export default function Layout() {
  return (
    <AppProviders>
      <Outlet />
    </AppProviders>
  );
}
