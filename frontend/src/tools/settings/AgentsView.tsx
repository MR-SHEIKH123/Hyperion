import type {
  PermissionRuleWire,
  PermissionsWire,
  ProfileImportResultWire,
  ProjectAgentWire,
  ProjectCommandWire,
  PublicProfileWire,
} from '../../contracts/wire/agents';
import { IMPORT_STATUS_LABELS, LAYER_LINES, MODE_LINES, profileOrigin } from './agentsModel';
import styles from './DataView.module.css';

/**
 * Presentational pieces for Agents and permissions (Settings 2.5, slice
 * 4). Everything here renders what the backend reported — profile bodies
 * are not part of the listing API, so no view below invents a preview,
 * and the permission layers are shown in the evaluation order the route
 * returns them in.
 */

export function ProfileList({ profiles }: { profiles: readonly PublicProfileWire[] }) {
  if (profiles.length === 0) return <p className={styles.fact}>No profiles found.</p>;
  return (
    <ul className={styles.list}>
      {profiles.map((profile) => (
        <li key={profile.name} className={styles.entry}>
          <p className={styles.fact}>
            {profile.name}{' '}
            <span className={styles.badge}>{profileOrigin(profile)}</span>{' '}
            <span className={styles.badge}>{profile.mode}</span>{' '}
            {profile.hidden ? <span className={styles.badge}>Hidden from run pickers</span> : null}{' '}
            {profile.visibility === 'subagent' ? <span className={styles.badge}>Subagent only</span> : null}
          </p>
          {profile.description !== null ? <p className={styles.note}>{profile.description}</p> : null}
          <div className={styles.entryMeta}>
            <span>
              {profile.model !== null ? `Model: ${profile.model} · ` : ''}
              {profile.tools === null ? 'All registered tools' : `${profile.tools.length} tools named`}
              {profile.variant !== null ? ` · Reasoning: ${profile.variant}` : ''}
            </span>
            {profile.path !== null ? <span className={styles.mono}>{profile.path}</span> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function RuleValue({ rule }: { rule: PermissionRuleWire }) {
  if (typeof rule === 'string') return <span className={styles.badge}>{rule}</span>;
  return (
    <ul className={styles.steps}>
      {Object.entries(rule).map(([glob, action]) => (
        <li key={glob}>
          <span className={styles.mono}>{glob}</span> → <span className={styles.badge}>{action}</span>
        </li>
      ))}
    </ul>
  );
}

export function PermissionLayersView({ permissions }: { permissions: PermissionsWire }) {
  return (
    <div>
      <p className={styles.fact}>
        Profile “{permissions.profile.name}” ({permissions.profile.builtin ? 'built-in' : 'project'}, base mode{' '}
        {permissions.profile.mode}: {MODE_LINES[permissions.profile.mode]})
      </p>
      {permissions.layers.map((layer) => (
        <div key={layer.layer}>
          <h4 className={styles.panelTitle}>
            {layer.layer} <span className={styles.note}>{LAYER_LINES[layer.layer]}</span>
          </h4>
          {Object.keys(layer.rules).length === 0 ? (
            <p className={styles.note}>No rules in this layer.</p>
          ) : (
            <table className={styles.table}>
              <tbody>
                {Object.entries(layer.rules).map(([key, rule]) => (
                  <tr key={key}>
                    <td className={styles.mono}>{key}</td>
                    <td>
                      <RuleValue rule={rule} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

export function ImportResultsView({ results }: { results: readonly ProfileImportResultWire[] }) {
  return (
    <ul className={styles.list}>
      {results.map((result) => (
        <li key={`${result.filename}:${result.status}`} className={styles.entry}>
          <p className={styles.fact}>
            <span className={styles.mono}>{result.filename}</span>{' '}
            <span
              className={`${styles.badge} ${result.status === 'skipped' || result.status === 'invalid' ? styles.badgeWarn : ''}`}
            >
              {IMPORT_STATUS_LABELS[result.status] ?? result.status}
            </span>
          </p>
          <p className={styles.note}>
            {result.name !== null ? `Profile “${result.name}”. ` : ''}
            {result.path !== undefined ? `Filed at ${result.path}. ` : ''}
            {result.error !== undefined ? result.error : ''}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function ProjectAgentsList({ agents }: { agents: readonly ProjectAgentWire[] }) {
  if (agents.length === 0)
    return <p className={styles.fact}>No sub-agent files. Imported profiles land here as they are filed.</p>;
  return (
    <ul className={styles.list}>
      {agents.map((agent) => (
        <li key={agent.path} className={styles.entry}>
          <div className={styles.entryMeta}>
            <span>
              {agent.name}
              {agent.model !== null ? ` · model ${agent.model}` : ''}
              {agent.tools !== null ? ` · ${agent.tools.length} tools named` : ''}
            </span>
            <span className={styles.mono}>{agent.path}</span>
          </div>
          {agent.description !== null ? <p className={styles.note}>{agent.description}</p> : null}
        </li>
      ))}
    </ul>
  );
}

export function ProjectCommandsList({ commands }: { commands: readonly ProjectCommandWire[] }) {
  if (commands.length === 0) return <p className={styles.fact}>No custom commands declared.</p>;
  return (
    <ul className={styles.list}>
      {commands.map((command) => (
        <li key={command.path} className={styles.entry}>
          <div className={styles.entryMeta}>
            <span>{command.name}</span>
            <span className={styles.mono}>{command.path}</span>
          </div>
          {command.description !== null ? <p className={styles.note}>{command.description}</p> : null}
        </li>
      ))}
    </ul>
  );
}
