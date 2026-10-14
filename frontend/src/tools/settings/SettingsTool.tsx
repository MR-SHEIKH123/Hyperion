import { useEffect } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';

import { usePersistenceStore } from '../../state/persistence/PersistenceProvider';
import { ProvidersSection } from './ProvidersSection';
import styles from './SettingsTool.module.css';

/**
 * Settings (Addendum 2.5). Slice 1 builds Providers only; the other sections
 * are named here with the slice that builds them and render the same honest
 * "not built yet" answer the placeholders use — no fake panels, no dead
 * controls. The last visited section is remembered as presentation state (a
 * section slug only — nothing about providers themselves is stored).
 */
export const SETTINGS_SECTIONS = [
  { id: 'providers', label: 'Providers', slice: 'Slice 1' },
  { id: 'safety', label: 'Safety and limits', slice: 'Slice 2' },
  { id: 'memory', label: 'Memory and data', slice: 'Slice 3' },
  { id: 'agents', label: 'Agents and permissions', slice: 'Slice 4' },
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

  const current = SETTINGS_SECTIONS.find((entry) => entry.id === section) ?? SETTINGS_SECTIONS[0];

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
                {entry.id !== 'providers' ? <span className={styles.navSlice}>{entry.slice}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className={styles.content}>
        {section === 'providers' ? (
          <ProvidersSection />
        ) : (
          <section aria-labelledby="settings-pending-title">
            <h2 id="settings-pending-title">{current.label}</h2>
            <p className={styles.pending} role="note">
              This section is not built yet — it arrives with Settings {current.slice} ({current.label}). Providers
              (Slice 1) is the live section today; nothing here is a control, and nothing is stored from this page.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

export default SettingsTool;
