import { useQuery } from '@tanstack/react-query';

import { getArtifactVersions, getRunProvenance } from '../../api/provenance';
import { ErrorNotice } from '../ErrorNotice/ErrorNotice';
import styles from './ProvenancePanel.module.css';

import type { ArtifactVersion, RunKnowledgeSource } from '../../contracts/wire/provenance';

/**
 * Provenance: what a piece of work was built on (Prompt 1.39 A6).
 *
 * Two things, and the component shows nothing else — the item's own rule is that
 * provenance adds *only* the parent version and the knowledge sources used, so
 * there is no author, no model, no timestamp beyond the ones those two fields
 * carry. A panel that grew a third section would be inventing provenance.
 *
 * The presentational halves are exported separately from the query, so a caller
 * with the data already (a tool surface that fetched it with the rest of a task)
 * renders the same view without a second request, and so the harness can show
 * every state without a server.
 */

function abbreviate(digest: string): string {
  return `${digest.slice(0, 8)}…`;
}

/** One version, and the version it replaced. */
export function VersionRow({ version }: { version: ArtifactVersion }) {
  const size = version.bytes === null ? 'size unknown' : `${String(version.bytes)} bytes`;
  const digest = version.sha256 === null ? 'not hashed' : abbreviate(version.sha256);
  return (
    <li className={styles.row}>
      <span className={styles.version}>v{version.version}</span>
      <span className={styles.detail}>
        <span className={styles.label}>{version.label ?? 'unlabelled'}</span>
        <span className={styles.meta}>
          {size} · {digest}
          {/* The one relationship provenance states. Phrased as a fact about the
              chain, and `null` is only ever the first version — the backend
              derives it, so this never has to guess. */}
          {version.parentVersion === null
            ? ' · first version'
            : ` · replaced v${String(version.parentVersion)}`}
          {version.inline ? '' : ' · stored as a file'}
        </span>
      </span>
    </li>
  );
}

export function VersionTimeline({ versions }: { versions: ArtifactVersion[] }) {
  if (versions.length === 0) {
    // "Nothing was versioned" is a fact about the editing path, not an absence of
    // the file: versioning happens on write, so a file that has never been edited
    // through the tools has no versions at all.
    return (
      <p className={styles.empty}>
        No versions recorded. A version is written before each edit, so a file that has not been
        changed through the tools has none.
      </p>
    );
  }
  return (
    <ol className={styles.list} aria-label="Version timeline">
      {versions.map((version) => (
        <VersionRow key={version.id} version={version} />
      ))}
    </ol>
  );
}

export function KnowledgeSourceList({ sources }: { sources: RunKnowledgeSource[] }) {
  if (sources.length === 0) {
    return (
      <p className={styles.empty}>
        No knowledge sources were used as evidence for this run.
      </p>
    );
  }
  return (
    <ul className={styles.list} aria-label="Knowledge sources used">
      {sources.map((source) => (
        <li className={styles.row} key={source.sourceId}>
          <span className={styles.version} aria-hidden="true">
            ▤
          </span>
          <span className={styles.detail}>
            <span className={styles.label}>{source.label ?? source.filename}</span>
            <span className={styles.meta}>
              {source.filename}
              {source.sha256 === null ? ' · digest not recorded' : ` · ${abbreviate(source.sha256)}`}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

interface ProvenancePanelProps {
  /** An artifact whose version timeline to show. Omit for the knowledge-only view. */
  artifactKey?: string;
  /** A Cowork task whose run evidence to show. */
  taskId?: string;
}

/**
 * The container: two independent reads, each rendering its own failure.
 *
 * They are deliberately not one query. A version timeline that fails must not take
 * the knowledge list down with it — they come from different routes and different
 * stores — and the panel is meant to be trustworthy at a glance, which means a
 * failure has to be visible as a failure rather than as an empty list.
 */
export function ProvenancePanel({ artifactKey, taskId }: ProvenancePanelProps) {
  return (
    <section className={styles.panel} aria-label="Provenance">
      {artifactKey !== undefined && <VersionSection artifactKey={artifactKey} />}
      {taskId !== undefined && <KnowledgeSection taskId={taskId} />}
    </section>
  );
}

function VersionSection({ artifactKey }: { artifactKey: string }) {
  const query = useQuery({
    queryKey: ['provenance', 'versions', artifactKey],
    queryFn: ({ signal }) => getArtifactVersions(artifactKey, signal),
    retry: false,
  });

  return (
    <div className={styles.section}>
      <h3 className={styles.heading}>Version history</h3>
      {query.isPending ? (
        <p className={styles.empty} role="status">
          Reading versions…
        </p>
      ) : query.isError ? (
        <ErrorNotice onRetry={() => void query.refetch()} />
      ) : (
        <VersionTimeline versions={query.data.versions} />
      )}
    </div>
  );
}

function KnowledgeSection({ taskId }: { taskId: string }) {
  const query = useQuery({
    queryKey: ['provenance', 'knowledge', taskId],
    queryFn: ({ signal }) => getRunProvenance(taskId, signal),
    retry: false,
  });

  return (
    <div className={styles.section}>
      <h3 className={styles.heading}>Knowledge sources used</h3>
      {query.isPending ? (
        <p className={styles.empty} role="status">
          Reading sources…
        </p>
      ) : query.isError ? (
        <ErrorNotice onRetry={() => void query.refetch()} />
      ) : (
        <KnowledgeSourceList sources={query.data.knowledgeSources} />
      )}
    </div>
  );
}
