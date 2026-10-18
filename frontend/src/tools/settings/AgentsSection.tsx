import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getAgentProfiles,
  getAgentsSettings,
  getPermissions,
  getProjectAgents,
  getProjectCommands,
  getProjectRules,
  importAgentProfiles,
  setDefaultAgentProfile,
  type ImportConflictPolicy,
} from '../../api/agents';
import { Button } from '../../design-system/components/Button/Button';
import { Dialog } from '../../design-system/components/Dialog/Dialog';
import type { ProfileImportWire } from '../../contracts/wire/agents';
import { describeApiError } from './ProvidersSection';
import { MODE_LINES, PROFILE_IMPORT_MAX_FILES, collidingFiles } from './agentsModel';
import { ImportResultsView, PermissionLayersView, ProfileList, ProjectAgentsList, ProjectCommandsList } from './AgentsView';
import styles from './DataView.module.css';

/**
 * Agents and permissions (Settings 2.5, slice 4).
 *
 * The only writes are the stored default profile and the profile import.
 * The permission layers are a read-only view: rules live in project
 * files, and this screen says so where a user would look for an edit
 * control. Reload Config stays in Safety and limits — linked, not
 * duplicated.
 */

const MODES = ['ask', 'plan', 'act'] as const;

export function AgentsSection() {
  const queryClient = useQueryClient();
  const profilesQuery = useQuery({ queryKey: ['agents', 'profiles'], queryFn: ({ signal }) => getAgentProfiles(signal) });
  const settingsQuery = useQuery({ queryKey: ['agents', 'settings'], queryFn: ({ signal }) => getAgentsSettings(signal) });
  const rulesQuery = useQuery({ queryKey: ['agents', 'rules'], queryFn: ({ signal }) => getProjectRules(signal) });
  const agentsQuery = useQuery({ queryKey: ['agents', 'project-agents'], queryFn: ({ signal }) => getProjectAgents(signal) });
  const commandsQuery = useQuery({ queryKey: ['agents', 'commands'], queryFn: ({ signal }) => getProjectCommands(signal) });

  const [notice, setNotice] = useState<string | null>(null);

  // Default profile form.
  const [defaultChoice, setDefaultChoice] = useState<string | null>(null);
  const [defaultPending, setDefaultPending] = useState(false);
  const [defaultError, setDefaultError] = useState<string | null>(null);

  // Permissions view controls.
  const [mode, setMode] = useState<(typeof MODES)[number]>('act');
  const [profileChoice, setProfileChoice] = useState('');
  const permissionsQuery = useQuery({
    queryKey: ['agents', 'permissions', mode, profileChoice],
    queryFn: ({ signal }) => getPermissions({ mode, ...(profileChoice !== '' ? { profile: profileChoice } : {}) }, signal),
  });

  // Import state.
  const [picked, setPicked] = useState<File[]>([]);
  const [policy, setPolicy] = useState<ImportConflictPolicy>('skip');
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [importPending, setImportPending] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importOutcome, setImportOutcome] = useState<ProfileImportWire | null>(null);

  const profiles = profilesQuery.data?.profiles ?? [];
  const storedDefault = settingsQuery.data?.defaultAgentProfile ?? null;
  const chosenDefault = defaultChoice ?? storedDefault ?? '';
  const existingAgents = agentsQuery.data?.agents ?? [];
  const collisions = collidingFiles(picked, existingAgents);

  const invalidateAgents = () => {
    void queryClient.invalidateQueries({ queryKey: ['agents'] });
  };

  const saveDefault = async () => {
    setDefaultPending(true);
    setDefaultError(null);
    try {
      const result = await setDefaultAgentProfile(chosenDefault === '' ? null : chosenDefault);
      setDefaultChoice(null);
      invalidateAgents();
      setNotice(
        result.defaultAgentProfile === null
          ? 'Stored default cleared. Act runs use the act built-in; Ask and Plan always use their own.'
          : `Default profile set to “${result.defaultAgentProfile}”. It applies to Act runs; Ask and Plan always use their own built-ins.`,
      );
    } catch (error) {
      setDefaultError(describeApiError(error));
    } finally {
      setDefaultPending(false);
    }
  };

  const runImport = async (confirmed: boolean) => {
    setImportPending(true);
    setImportError(null);
    try {
      const outcome = await importAgentProfiles(picked, {
        onConflict: policy,
        ...(policy === 'overwrite' ? { confirm: confirmed } : {}),
      });
      setImportOutcome(outcome);
      setConfirmOverwrite(false);
      setNotice(`Filed ${outcome.imported} of ${outcome.count} profiles into ${outcome.project.name}.`);
      invalidateAgents();
    } catch (error) {
      // A 409 here is the no-active-project state, in the backend's words.
      setImportOutcome(null);
      setImportError(describeApiError(error));
    } finally {
      setImportPending(false);
    }
  };

  const startImport = () => {
    if (picked.length === 0) return;
    if (policy === 'overwrite') {
      setConfirmOverwrite(true);
      return;
    }
    void runImport(false);
  };

  const rules = rulesQuery.data;

  return (
    <section aria-labelledby="agents-heading">
      <h2 id="agents-heading">Agents and permissions</h2>
      <p className={styles.intro}>
        Which profile runs by default, what each profile may do, and the project files those rules come from. Rules are
        read here and edited in the project files themselves; to pick up file changes, use{' '}
        <Link to="/settings/safety">Reload Config in Safety and limits</Link>.
      </p>
      {notice !== null ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}

      <div className={styles.panels}>
        <div className={styles.panel}>
          <h3 className={styles.panelTitle}>Default profile</h3>
          {settingsQuery.isPending || profilesQuery.isPending ? (
            <p className={styles.fact}>Reading profiles…</p>
          ) : settingsQuery.isError ? (
            <p className={styles.panelError} role="alert">
              The default profile could not be read. {describeApiError(settingsQuery.error)}
            </p>
          ) : (
            <>
              <p className={styles.fact}>
                {storedDefault === null
                  ? 'No stored default. Act runs use the act built-in.'
                  : `Stored default: “${storedDefault}”, used by Act runs.`}{' '}
                Ask always resolves to ask ({MODE_LINES.ask}) and Plan to plan ({MODE_LINES.plan}), whatever is stored
                here.
              </p>
              <div className={styles.field}>
                <label htmlFor="default-profile">Default for Act runs</label>
                <select
                  id="default-profile"
                  value={chosenDefault}
                  onChange={(event) => setDefaultChoice(event.target.value)}
                >
                  <option value="">No stored default (act built-in)</option>
                  {profiles.map((profile) => (
                    <option key={profile.name} value={profile.name}>
                      {profile.name} ({profile.builtin ? 'built-in' : 'project'})
                    </option>
                  ))}
                  {storedDefault !== null && !profiles.some((profile) => profile.name === storedDefault) ? (
                    <option value={storedDefault}>{storedDefault} (not in the current listing)</option>
                  ) : null}
                </select>
                <p className={styles.note}>
                  A project profile is checked again when a run starts; a name that no longer resolves falls back to
                  the act built-in rather than failing the run.
                </p>
              </div>
              <div className={styles.actions}>
                <Button variant="primary" onClick={() => void saveDefault()} disabled={defaultPending}>
                  {defaultPending ? 'Saving…' : 'Save default'}
                </Button>
              </div>
              {defaultError !== null ? (
                <p className={styles.panelError} role="alert">
                  {defaultError}
                </p>
              ) : null}
            </>
          )}
        </div>

        <div className={styles.panel}>
          <h3 className={styles.panelTitle}>Profiles</h3>
          {profilesQuery.isPending ? (
            <p className={styles.fact}>Reading profiles…</p>
          ) : profilesQuery.isError ? (
            <p className={styles.panelError} role="alert">
              Profiles could not be listed. {describeApiError(profilesQuery.error)}
            </p>
          ) : (
            <>
              <p className={styles.note}>
                {profilesQuery.data.count} profiles, hidden ones included. A hidden profile is only hidden from the
                run pickers — it still resolves by name. The profile text itself lives in its file and is not shown
                here.
              </p>
              <ProfileList profiles={profiles} />
            </>
          )}
        </div>

        <div className={styles.panel}>
          <h3 className={styles.panelTitle}>Import profiles</h3>
          <p className={styles.note}>
            Files <span className={styles.mono}>.md</span> profiles into the active project’s{' '}
            <span className={styles.mono}>.hyperion/agents/</span> — at most {PROFILE_IMPORT_MAX_FILES} at a time, each
            at most 64 KiB. With no project open there is nowhere to file them, and the import says so.
          </p>
          <div className={styles.field}>
            <label htmlFor="profile-files">Profile files (.md)</label>
            <input
              id="profile-files"
              type="file"
              accept=".md"
              multiple
              onChange={(event) => {
                setPicked([...(event.target.files ?? [])]);
                setImportOutcome(null);
              }}
            />
            {picked.length > 0 ? (
              <p className={styles.note}>
                {picked.length} file{picked.length === 1 ? '' : 's'} picked
                {picked.length > PROFILE_IMPORT_MAX_FILES
                  ? ` — more than the ${PROFILE_IMPORT_MAX_FILES}-file limit; the import will be refused`
                  : ''}
                .
              </p>
            ) : null}
          </div>
          <fieldset className={styles.field}>
            <legend className={styles.note}>When a filename already exists</legend>
            {(
              [
                ['skip', 'Skip it (the existing file stays)'],
                ['rename', 'File the new one under a numbered name (<stem>-2.md)'],
                ['overwrite', 'Replace the existing file (asks first, naming what it replaces)'],
              ] as [ImportConflictPolicy, string][]
            ).map(([value, label]) => (
              <label key={value} className={styles.checkField}>
                <input
                  type="radio"
                  name="on-conflict"
                  value={value}
                  checked={policy === value}
                  onChange={() => setPolicy(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <div className={styles.actions}>
            <Button variant="primary" onClick={startImport} disabled={picked.length === 0 || importPending}>
              {importPending ? 'Importing…' : policy === 'overwrite' ? 'Import (overwrite)…' : 'Import'}
            </Button>
          </div>
          {importError !== null ? (
            <p className={styles.panelError} role="alert">
              {importError}
            </p>
          ) : null}
          {importOutcome !== null ? (
            <>
              <p className={styles.fact} role="status">
                Filed {importOutcome.imported} of {importOutcome.count} into {importOutcome.project.name}.
              </p>
              <ImportResultsView results={importOutcome.results} />
            </>
          ) : null}
        </div>

        <div className={styles.panel}>
          <h3 className={styles.panelTitle}>Permission rules (read-only)</h3>
          <p className={styles.note}>
            The layers a run is judged by, in the order they are evaluated. There is no edit control here because
            there is nothing in the app to edit: rules live in the project files below, and changing a file is how a
            rule changes.
          </p>
          <div className={styles.grid2}>
            <div className={styles.field}>
              <label htmlFor="permissions-mode">Base mode</label>
              <select
                id="permissions-mode"
                value={mode}
                onChange={(event) => setMode(event.target.value as (typeof MODES)[number])}
              >
                {MODES.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry} — {MODE_LINES[entry]}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="permissions-profile">Profile</label>
              <select
                id="permissions-profile"
                value={profileChoice}
                onChange={(event) => setProfileChoice(event.target.value)}
              >
                <option value="">(the profile this mode resolves to)</option>
                {profiles.map((profile) => (
                  <option key={profile.name} value={profile.name}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {permissionsQuery.isPending ? (
            <p className={styles.fact}>Reading the rules…</p>
          ) : permissionsQuery.isError ? (
            <p className={styles.panelError} role="alert">
              The permission rules could not be read. {describeApiError(permissionsQuery.error)}
            </p>
          ) : permissionsQuery.data !== undefined ? (
            <PermissionLayersView permissions={permissionsQuery.data} />
          ) : null}
        </div>

        <div className={styles.panel}>
          <h3 className={styles.panelTitle}>Project files</h3>
          {rulesQuery.isPending || agentsQuery.isPending || commandsQuery.isPending ? (
            <p className={styles.fact}>Reading the project files…</p>
          ) : rulesQuery.isError || agentsQuery.isError || commandsQuery.isError ? (
            <p className={styles.panelError} role="alert">
              The project files could not be listed.
            </p>
          ) : (
            <>
              <p className={styles.fact}>
                {rules === undefined || rules.source === 'none'
                  ? 'No rules files found for this project.'
                  : rules.source === 'hyperion-md'
                    ? `Rules come from HYPERION.md at the project root (${rules.count} rules).`
                    : `Rules come from .hyperion/rules (${rules.count} rules).`}
              </p>
              {rules !== undefined && rules.rules.length > 0 ? (
                <ul className={styles.list}>
                  {rules.rules.map((rule) => (
                    <li key={rule.path} className={styles.entry}>
                      <div className={styles.entryMeta}>
                        <span>
                          {rule.name}
                          {rule.scope !== null ? ` · applies to ${rule.scope}` : ''}
                        </span>
                        <span className={styles.mono}>{rule.path}</span>
                      </div>
                      {rule.description !== null ? <p className={styles.note}>{rule.description}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              <h4 className={styles.panelTitle}>Sub-agents</h4>
              <ProjectAgentsList agents={existingAgents} />
              <h4 className={styles.panelTitle}>Custom commands</h4>
              <ProjectCommandsList commands={commandsQuery.data?.commands ?? []} />
            </>
          )}
        </div>
      </div>

      <Dialog open={confirmOverwrite} title="Replace existing profiles?" onClose={() => setConfirmOverwrite(false)}>
        <div className={styles.confirmBody}>
          {collisions.length > 0 ? (
            <>
              <p>Overwriting replaces these files in the active project’s .hyperion/agents/:</p>
              <ul className={styles.list}>
                {collisions.map(({ file, existingName }) => (
                  <li key={file.name} className={styles.entry}>
                    <span className={styles.mono}>{file.name}</span> — replaces the profile “{existingName}”. The
                    current file’s contents are lost; nothing keeps a copy.
                  </li>
                ))}
              </ul>
              <p>Picked files with no match above are imported as new.</p>
            </>
          ) : (
            <p>
              None of the picked files shares a filename with the profiles listed above, so nothing listed would be
              replaced. Overwrite still applies to any same-named file in the active project that the listing did not
              show. The current contents of any replaced file are lost.
            </p>
          )}
          {importError !== null ? (
            <p className={styles.panelError} role="alert">
              {importError}
            </p>
          ) : null}
          <div className={styles.confirmActions}>
            <Button onClick={() => setConfirmOverwrite(false)} disabled={importPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void runImport(true)} disabled={importPending}>
              {importPending ? 'Importing…' : 'Replace and import'}
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
