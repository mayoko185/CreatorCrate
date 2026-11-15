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
  };
}
