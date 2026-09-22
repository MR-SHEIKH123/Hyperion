import { NavLink } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import { useAttention } from './useAttention';
import styles from './AttentionNavLink.module.css';

/**
 * The rail's Attention entry — its own element above the eight tools, because the
 * queue is not a tool: it is the one place that answers "what is waiting on me,
 * anywhere", and the first thing it usually shows is a Code approval.
 *
 * The count is part of the link's accessible name (`Attention, 3 waiting`) rather
 * than a decorative chip, so the information exists for a screen reader too. A
 * failed poll renders no count and no alarm: the surface itself reports read
 * failures, with a retry beside them, and a background refresh turning the rail
 * red would be crying wolf from a place that cannot explain itself.
 */
export function AttentionNavLink() {
  const query = useAttention();
  const total = query.isError ? 0 : (query.data?.total ?? 0);

  return (
    <NavLink
      to="/attention"
      className={({ isActive }) => `${styles.item} ${isActive ? styles.active : ''}`}
      aria-label={total === 0 ? 'Attention' : `Attention, ${String(total)} waiting`}
    >
      <Inbox className={styles.icon} aria-hidden="true" />
      <span className={styles.label}>Attention</span>
      {total === 0 ? null : <span className={styles.count}>{total > 99 ? '99+' : String(total)}</span>}
    </NavLink>
  );
}
