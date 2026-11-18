export function createAppMetaRepository(db) {
  const getValueStmt = db.prepare(
    'SELECT value FROM app_meta WHERE key = ?'
  );
  const setValueStmt = db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    RETURNING value
  `);
  const deleteValueStmt = db.prepare(
    'DELETE FROM app_meta WHERE key = ?'
  );
  // One transaction so a scoped reset of several keys either fully applies or
  // leaves every key as it was. Nested inside a caller's transaction it
  // becomes a savepoint of that transaction.
  const deleteValuesTx = db.transaction((keys) => keys.filter(
    (key) => deleteValueStmt.run(key).changes > 0,
  ));
  // Compare-and-increment of a durable non-negative integer counter. The read,
  // comparison and write run in one transaction (a savepoint when nested in a
  // caller's transaction), so two callers expecting the same value can never
  // both advance it, and a caller's rollback also rolls the counter back.
  const compareAndIncrementTx = db.transaction((key, expected) => {
    const current = parseCounter(getValueStmt.get(key)?.value, key);
    if (!Number.isSafeInteger(expected) || expected !== current) {
      return { advanced: false, current };
    }
    const next = current + 1;
    setValueStmt.get(key, String(next));
    return { advanced: true, current: next };
  });
  return {
    getValue(key) {
      const row = getValueStmt.get(key);
      return row ? row.value : undefined;
    },

    setValue(key, value) {
      return setValueStmt.get(key, value).value;
    },

    setValueWithOutcome(key, value, { fallbackValue } = {}) {
      const previousValue = getValueStmt.get(key)?.value ?? fallbackValue;
      setValueStmt.get(key, value);
      return { value, changed: previousValue !== value };
    },

    /**
     * Deletes exactly the supplied keys and returns the ones that existed.
     * Callers own the key allowlist; this never matches by prefix.
     */
    deleteValues(keys) {
      return deleteValuesTx([...keys]);
    },

    /** The stored counter (an absent key is 0). A corrupt value throws. */
    getCounter(key) {
      return parseCounter(getValueStmt.get(key)?.value, key);
    },

    /**
     * Advances the counter only when it still equals `expected`. Returns
     * `{ advanced, current }`, where `current` is the value after the call.
     */
    compareAndIncrement(key, expected) {
      return compareAndIncrementTx(key, expected);
    },
  };
}

function parseCounter(value, key) {
  if (value === undefined || value === null) return 0;
  const parsed = /^(0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`app_meta counter "${key}" is not a non-negative integer.`);
  }
  return parsed;
}
