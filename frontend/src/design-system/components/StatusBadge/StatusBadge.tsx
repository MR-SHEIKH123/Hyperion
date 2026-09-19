import styles from'./StatusBadge.module.css';
export function StatusBadge({tone='neutral',children}:React.PropsWithChildren<{tone?:'success'|'warning'|'error'|'info'|'neutral'}>){return <span className={`${styles.badge} ${styles[tone]}`}><span className={styles.dot} aria-hidden="true"/>{children}</span>}
