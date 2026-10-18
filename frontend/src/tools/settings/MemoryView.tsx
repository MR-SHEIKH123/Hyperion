import { useId, useRef, useState, type FormEvent } from 'react';

import { Button } from '../../design-system/components/Button/Button';
import type { MemoryEntryWire, MemoryImportWire, MemoryStatusWire } from '../../contracts/wire/memory';
import { describeApiError } from './ProvidersSection';
import { formatMemoryDate, MEMORY_IMPORT_MAX_FILES, MEMORY_MAX_CHARS, validateMemoryText } from './memoryModel';
import styles from './MemoryView.module.css';

/**
 * The Memory section's presentational half (Settings 2.5, slice 3a).
 * Memory content is rendered as text and only as text — React text nodes,
 * never markup — because a stored memory is untrusted content that a later
 * surface happens to be showing back.
 */

export function MemoryStatusPanel(props: {
  status: MemoryStatusWire;
  pending: boolean;
  error: string | null;
  onEnable: () => void;
  onDisable: () => void;
}) {
  const { status } = props;
  return (
    <article className={styles.panel}>
      <h3 className={styles.panelTitle}>Memory</h3>
      {status.enabled ? (
        status.available ? (
          <p className={styles.fact}>
            On. Facts are extracted with {status.llmModel}, embedded with {status.embedModel}, and up to{' '}
            {status.retrieveLimit} are recalled per turn.
          </p>
        ) : (
          <p className={styles.warning} role="note">
            On, but unavailable: the memory backend did not load
            {status.error === null ? '.' : ` — ${status.error}`} Nothing can be stored or recalled until it
            does; the list below is empty for that reason, not necessarily because nothing was ever stored.
          </p>
        )
      ) : (
        <p className={styles.fact}>
          Off. Memory is opt-in: nothing is stored, and nothing is recalled into a conversation.
        </p>
      )}
      <p className={styles.note}>Stored under {status.storeDir}.</p>
      <div className={styles.actions}>
        {status.enabled ? (
          <>
            {status.available ? null : (
              <Button variant="primary" onClick={props.onEnable} disabled={props.pending}>
                Retry loading the backend
              </Button>
            )}
            <Button onClick={props.onDisable} disabled={props.pending}>
              Disable memory
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={props.onEnable} disabled={props.pending}>
            Enable memory
          </Button>
        )}
      </div>
      {props.error !== null ? (
        <p className={styles.panelError} role="alert">
          {props.error}
        </p>
      ) : null}
    </article>
  );
}

export function MemoryList(props: { memories: MemoryEntryWire[]; onDeleteOne: (memory: MemoryEntryWire) => void }) {
  if (props.memories.length === 0) {
    return (
      <article className={styles.panel}>
        <h3 className={styles.panelTitle}>Stored memories</h3>
        <p className={styles.fact}>No memories stored yet. Add one below, or import a paste or a folder.</p>
      </article>
    );
  }
  return (
    <article className={styles.panel}>
      <h3 className={styles.panelTitle}>Stored memories ({props.memories.length})</h3>
      <ul className={styles.list}>
        {props.memories.map((memory) => (
          <li key={memory.id} className={styles.entry}>
            <p className={styles.memoryText}>{memory.memory}</p>
            <div className={styles.entryMeta}>
              <span>
                {formatMemoryDate(memory.createdAt)}
                {memory.tool === null ? '' : ` · from ${memory.tool}`}
                {memory.chatId === null ? '' : ` · chat ${memory.chatId}`}
              </span>
              <Button variant="quiet" onClick={() => props.onDeleteOne(memory)}>
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </article>
  );
}

export function AddMemoryForm(props: { onAdd: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const id = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = validateMemoryText(text);
    if (invalid !== null) {
      setError(invalid);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await props.onAdd(text);
      setText('');
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <article className={styles.panel}>
      <h3 className={styles.panelTitle}>Add a memory</h3>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className={styles.field}>
          <label htmlFor={`${id}-text`}>One fact, in your own words</label>
          <textarea
            id={`${id}-text`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={3}
            aria-describedby={`${id}-count`}
          />
          <p className={styles.note} id={`${id}-count`}>
            {text.length} of {MEMORY_MAX_CHARS} characters. It is stored as written; nothing rewords it.
          </p>
        </div>
        {error !== null ? (
          <p className={styles.panelError} role="alert">
            {error}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button variant="primary" type="submit" disabled={pending}>
            {pending ? 'Storing…' : 'Store memory'}
          </Button>
        </div>
      </form>
    </article>
  );
}

export function ImportPanel(props: {
  onImportText: (text: string) => Promise<MemoryImportWire>;
  onImportFiles: (files: readonly File[]) => Promise<MemoryImportWire>;
}) {
  const [paste, setPaste] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<MemoryImportWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const id = useId();
  const folderInput = useRef<HTMLInputElement>(null);

  const run = async (action: () => Promise<MemoryImportWire>) => {
    setPending(true);
    setError(null);
    setResult(null);
    try {
      setResult(await action());
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setPending(false);
    }
  };

  const importFiles = () => {
    if (files.length === 0) {
      setError('Choose at least one file first.');
      return;
    }
    if (files.length > MEMORY_IMPORT_MAX_FILES) {
      setError(`At most ${MEMORY_IMPORT_MAX_FILES} files may be imported at once — the route refuses a larger batch whole rather than importing part of it.`);
      return;
    }
    void run(() => props.onImportFiles(files));
  };

  return (
    <article className={styles.panel}>
      <h3 className={styles.panelTitle}>Import memories</h3>
      <p className={styles.note}>
        A paste, or the files of a folder. Each file is split on blank lines, all files share one import budget
        (100 pieces, 20,000 characters), and pieces past the budget are counted as dropped — never silently
        truncated. One bad file does not stop the others; its row says what happened to it.
      </p>
      <div className={styles.field}>
        <label htmlFor={`${id}-paste`}>Paste text to import</label>
        <textarea
          id={`${id}-paste`}
          value={paste}
          onChange={(event) => setPaste(event.target.value)}
          rows={4}
          placeholder="One memory per paragraph…"
        />
      </div>
      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={() => {
            if (paste.trim().length === 0) {
              setError('Paste something first — an empty import stores nothing.');
              return;
            }
            void run(async () => {
              const outcome = await props.onImportText(paste);
              setPaste('');
              return outcome;
            });
          }}
          disabled={pending}
        >
          Import paste
        </Button>
      </div>
      <div className={styles.field}>
        <label htmlFor={`${id}-files`}>Or choose files (up to {MEMORY_IMPORT_MAX_FILES})</label>
        <input
          id={`${id}-files`}
          type="file"
          multiple
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
        />
        <input
          ref={folderInput}
          type="file"
          hidden
          {...({ webkitdirectory: '' } as Record<string, string>)}
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
        />
        <div className={styles.actions}>
          <Button onClick={() => folderInput.current?.click()}>Choose a folder instead</Button>
          <span className={styles.note}>{files.length === 0 ? 'No files chosen.' : `${files.length} file${files.length === 1 ? '' : 's'} chosen.`}</span>
          <Button variant="primary" onClick={importFiles} disabled={pending}>
            Import files
          </Button>
        </div>
      </div>
      {error !== null ? (
        <p className={styles.panelError} role="alert">
          {error}
        </p>
      ) : null}
      {result !== null ? (
        <div role="status">
          <p className={styles.fact}>
            Found {result.found}, imported {result.imported}, dropped {result.dropped}.
            {result.error === null ? '' : ` The run stopped early: ${result.error}.`}
          </p>
          {result.files !== undefined && result.files.length > 0 ? (
            <ul className={styles.fileResults}>
              {result.files.map((file) => (
                <li key={file.name}>
                  <span className={styles.mono}>{file.name}</span> — found {file.found}, imported {file.imported},
                  dropped {file.dropped}
                  {file.error === null ? '' : ` · ${file.error}`}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
