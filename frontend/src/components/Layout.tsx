import { NavLink, Link, Outlet } from 'react-router-dom';
import type { Me } from '../lib/api';
import { Logo } from './ui';
import { ThemeSwitch } from './feedback';

export const APP_NAME = 'Load Testing k6';

export function Layout({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand" aria-label={`${APP_NAME} home`}>
            <Logo />
            <span>Load Testing <small>k6</small></span>
          </Link>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>Runs</NavLink>
            <NavLink to="/new">New test</NavLink>
            <NavLink to="/compare">Compare</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <div className="topbar-right">
            <span className="project-chip" title="Project">{me.project.name}</span>
            <ThemeSwitch />
            <button className="btn btn-ghost btn-sm" onClick={onSignOut}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </>
  );
}
