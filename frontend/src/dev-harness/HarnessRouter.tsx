import { useState } from 'react';
import { Button } from '../design-system/components/Button/Button';
import { Dialog } from '../design-system/components/Dialog/Dialog';
import { StatusBadge } from '../design-system/components/StatusBadge/StatusBadge';
import { TaskStateBanner } from '../components/TaskStateBanner/TaskStateBanner';
import { ApertureMark } from '../design-system/components/ApertureMark/ApertureMark';
import styles from './HarnessRouter.module.css';
import { operationalFixtures } from './fixtures/operationalStates';
import { taskStateFixtures } from './fixtures/taskStates';

function fixtureTitle(id: string) {
  return id.replaceAll('_', ' ');
}

/**
 * The dangerous-command confirmation, rendered with the production Dialog.
 *
 * The Code tool has no approval surface yet, so this is a primitive preview
 * rather than a captured screen: it shows the shape the confirmation will take
 * (the exact command, the working directory, and a decision) without pretending
 * the surrounding task view exists.
 */
function DangerousCommandDialog() {
  const [open, setOpen] = useState(false);
  return (
    <article className={`${styles.card} ${styles.dialogCard}`} data-fixture="dangerous-command-confirm">
      <div>
        <h3>Dangerous command confirmation</h3>
        <p>
          Primitive preview: the Code approval surface is not built yet, so this renders the
          production Dialog with a fixture command.
        </p>
      </div>
      <Button variant="quiet" onClick={() => setOpen(true)}>
        Show confirmation
      </Button>
      <Dialog open={open} title="Run this command?" onClose={() => setOpen(false)}>
        <p className={styles.dialogCommand}>
          <code>rm -rf ./dist &amp;&amp; npm run build</code>
        </p>
        <p className={styles.dialogMeta}>Working directory: projects/hyperion</p>
        <div className={styles.dialogActions}>
          <Button variant="quiet" onClick={() => setOpen(false)}>
            Deny
          </Button>
          <Button variant="primary" onClick={() => setOpen(false)}>
            Allow once
          </Button>
        </div>
      </Dialog>
    </article>
  );
}

export function Component() {
  if (!import.meta.env.DEV) {
    throw new Error('The state harness is unavailable outside development.');
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <ApertureMark state="idle" />
        <div>
          <h1>Hyperion state harness</h1>
          <p className={styles.note}>Deterministic local fixtures · no provider or model calls</p>
        </div>
      </header>

      <section aria-labelledby="task-fixtures-heading">
        <h2 className={styles.sectionHeading} id="task-fixtures-heading">Task lifecycle fixtures</h2>
        <div className={styles.grid}>
          {Object.entries(taskStateFixtures).map(([id, state]) => (
            <article className={styles.card} key={id} data-fixture={`task-${id}`}>
              <h3>{fixtureTitle(id)}</h3>
              <TaskStateBanner state={state} />
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="operational-fixtures-heading" className={styles.section}>
        <h2 className={styles.sectionHeading} id="operational-fixtures-heading">Operational fixtures</h2>
        <div className={styles.grid}>
          {operationalFixtures.map((fixture) => (
            <article
              className={`${styles.card} ${styles.operational}`}
              key={fixture.id}
              data-fixture={fixture.id}
            >
              <div>
                <h3>{fixture.title}</h3>
                <p>{fixture.detail}</p>
                <p className={styles.source}>{fixture.source}</p>
              </div>
              <StatusBadge tone={fixture.tone}>{fixture.tone}</StatusBadge>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="dialog-fixtures-heading" className={styles.section}>
        <h2 className={styles.sectionHeading} id="dialog-fixtures-heading">Dialog fixtures</h2>
        <div className={styles.grid}>
          <DangerousCommandDialog />
        </div>
      </section>
    </main>
  );
}
