import { useEffect } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';

import { usePersistenceStore } from '../../state/persistence/PersistenceProvider';
import { ProvidersSection } from './ProvidersSection';
import { SafetySection } from './SafetySection';
import { MemorySection } from './MemorySection';
import { DataSection } from './DataSection';
import { AgentsSection } from './AgentsSection';
import styles from './SettingsTool.module.css';

/**
 * Settings (Addendum 2.5). All four sections are live: Providers, Safety
 * and limits, Memory and data, Agents and permissions. The last visited
 * section is remembered as presentation state (a section slug only —
 * nothing about providers themselves is stored).
 */
export const SETTINGS_SECTIONS = [
  { id: 'providers', label: 'Providers' },
  { id: 'safety', label: 'Safety and limits' },
  { id: 'memory', label: 'Memory and data' },
  { id: 'agents', label: 'Agents and permissions' },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

const isSectionId = (value: string | undefined): value is SettingsSectionId =>
  SETTINGS_SECTIONS.some((section) => section.id === value);

export function SettingsTool() {
  const location = useLocation();
  const store = usePersistenceStore();
  const segment = location.pathname.split('/').filter(Boolean)[1];
  const section: SettingsSectionId | null = isSectionId(segment) ? segment : null;

  const remembered = store.snapshot().projects['active']?.openViewIds['settings']?.[0];
  const rememberedSection: SettingsSectionId = isSectionId(remembered) ? remembered : 'providers';

  useEffect(() => {
    if (section === null) return;
    const previous = store.snapshot().projects['active'];
    if (previous?.openViewIds['settings']?.[0] === section) return;
    store.setProject('active', {
      openViewIds: { ...(previous?.openViewIds ?? {}), settings: [section] },
      selectedViewIds: previous?.selectedViewIds ?? {},
      selectedModelIds: previous?.selectedModelIds ?? {},
      panelLayouts: previous?.panelLayouts ?? {},
      lastViewedVersions: previous?.lastViewedVersions ?? {},
      ...(previous?.lastTool === undefined ? {} : { lastTool: previous.lastTool }),
    });
  }, [section, store]);

  if (segment === undefined) return <Navigate to={`/settings/${rememberedSection}`} replace />;
  if (section === null) return <Navigate to="/settings/providers" replace />;

  return (
    <div className={styles.layout}>
      <nav className={styles.nav} aria-label="Settings sections">
        <h1 className={styles.title}>Settings</h1>
        <ul className={styles.navList}>
          {SETTINGS_SECTIONS.map((entry) => (
            <li key={entry.id}>
              <Link
                to={`/settings/${entry.id}`}
                className={entry.id === section ? styles.navActive : styles.navLink}
                aria-current={entry.id === section ? 'page' : undefined}
              >
                {entry.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className={styles.content}>
        {section === 'providers' ? (
          <ProvidersSection />
        ) : section === 'safety' ? (
          <SafetySection />
        ) : section === 'memory' ? (
          <>
            <MemorySection />
            <DataSection />
          </>
        ) : (
          <AgentsSection />
        )}
      </div>
    </div>
  );
}

export default SettingsTool;
