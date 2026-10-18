import { BackupSection } from './BackupPanel';
import { S3Section } from './S3Panel';
import { StorageSection } from './StoragePanel';
import { UsageSection } from './UsagePanel';
import styles from './DataView.module.css';

/**
 * The Data half of "Memory and data" (Settings 2.5, slice 3b): backup and
 * restore, the S3 destination, storage and cleanup, and usage with its
 * prices. Each panel below is its own surface with its own honest
 * states; nothing here aggregates or hides a failure behind a total.
 */
export function DataSection() {
  return (
    <section aria-labelledby="data-heading">
      <h2 id="data-heading">Data</h2>
      <p className={styles.intro}>
        What Hyperion keeps on this machine, how to take it elsewhere, and what the work has cost. Exports are written
        locally first; restores replace rather than merge and are inspected before they are confirmed; costs are only
        ever as complete as the prices recorded for them.
      </p>
      <div className={styles.panels}>
        <BackupSection />
        <S3Section />
        <StorageSection />
        <UsageSection />
      </div>
    </section>
  );
}
