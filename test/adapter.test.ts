/**
 * The two database backends are interchangeable behind the adapter — including
 * the shape of the rows they hand back.
 *
 * `node:sqlite` returns rows with a null prototype; `better-sqlite3` returns
 * plain objects. Anything that looks at the prototype (`assert.deepEqual`, and
 * the migration tests' whole-row comparisons) can tell which backend is live,
 * which breaks the promise in the adapter's own header. This pins the normalized
 * shape rather than either driver's native one, so it holds on both backends.
 */
import './helpers.ts';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const { cleanupHome, freshDb } = await import('./helpers.ts');
const { getDb } = await import('../src/db/adapter.ts');

describe('the database adapter', () => {
  before(freshDb);
  after(cleanupHome);

  it('hands back plain objects on whichever backend is live', () => {
    const db = getDb();
    db.exec('CREATE TABLE probe (id TEXT PRIMARY KEY, n INTEGER)');
    db.prepare('INSERT INTO probe (id, n) VALUES (?, ?)').run('a', 1);

    const one = db.prepare<{ id: string; n: number }>('SELECT id, n FROM probe WHERE id = ?').get('a');
    assert.ok(one);
    assert.equal(Object.getPrototypeOf(one), Object.prototype);

    const many = db.prepare<{ id: string; n: number }>('SELECT id, n FROM probe').all();
    assert.equal(many.length, 1);
    assert.equal(Object.getPrototypeOf(many[0]), Object.prototype);

    // A miss stays a miss rather than an empty object.
    assert.equal(
      db.prepare<{ id: string; n: number }>('SELECT id, n FROM probe WHERE id = ?').get('nope'),
      undefined,
    );
  });
});
