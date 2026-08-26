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
  };
}
