import { TaskStateBanner } from '../components/TaskStateBanner/TaskStateBanner';
import { ApertureMark } from '../design-system/components/ApertureMark/ApertureMark';
import { StatusBadge } from '../design-system/components/StatusBadge/StatusBadge';
import styles from './HarnessRouter.module.css';
import { operationalFixtures } from './fixtures/operationalStates';
import { taskStateFixtures } from './fixtures/taskStates';

function fixtureTitle(id: string) {
  return id.replaceAll('_', ' ');
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
              </div>
              <StatusBadge tone={fixture.tone}>{fixture.tone}</StatusBadge>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
