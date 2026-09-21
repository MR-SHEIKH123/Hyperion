import { NavLink, Outlet } from 'react-router-dom';
import {
  Code2,
  FlaskConical,
  MessageSquare,
  Palette,
  Puzzle,
  Settings,
  Sparkles,
  Users,
} from 'lucide-react';
import { AttentionNavLink } from '../attention/AttentionNavLink';
import { ApertureMark } from '../design-system/components/ApertureMark/ApertureMark';
import { HealthIndicator } from './HealthIndicator';
import styles from './AppShell.module.css';

/**
 * The eight sidebar tools (SPEC: Chat, Code, Cowork, Design, Playground,
 * Plugins, Skills, Settings). Chat is the first fully-wired tool (Milestone B);
 * the others resolve to an honest placeholder until their increment lands.
 */
const NAV_ITEMS = [
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/code', label: 'Code', icon: Code2 },
  { to: '/cowork', label: 'Cowork', icon: Users },
  { to: '/design', label: 'Design', icon: Palette },
  { to: '/playground', label: 'Playground', icon: FlaskConical },
  { to: '/plugins', label: 'Plugins', icon: Puzzle },
  { to: '/skills', label: 'Skills', icon: Sparkles },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const;

export function AppShell() {
  return (
    <div className={styles.shell}>
      <aside className={styles.rail} aria-label="Hyperion tools">
        <div className={styles.brand}>
          <ApertureMark size={22} label="Hyperion" />
          <span className={styles.brandName}>Hyperion</span>
        </div>
        <nav className={styles.nav}>
          {/* Not a tool: the cross-tool queue, and the only rail entry whose count
              is about work waiting rather than a destination. */}
          <AttentionNavLink />
          <ul className={styles.navList}>
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <NavLink to={to} className={`${styles.navItem}`}>
                  <Icon className={`${styles.navIcon}`} aria-hidden="true" />
                  <span>{label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <footer className={styles.railFooter}>
          <HealthIndicator />
        </footer>
      </aside>
      <main className={styles.content}>
        <Outlet />
      </main>
    </div>
  );
}
