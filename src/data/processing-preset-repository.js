const PRESET_COLUMNS = [
  'id',
  'operation_type',
  'display_name',
  'system_key',
  'config_version',
  'config_json',
  'watermark_id',
  'scale_map_id',
  'created_at',
  'updated_at',
];

const SCALE_MAP_COLUMNS = [
  'id',
  'display_name',
  'system_key',
  'definition_json',
  'created_at',
  'updated_at',
];

/**
 * Persistence only: callers receive structured configs from the service and
 * never get to store filesystem paths or arbitrary executable commands.
 */
export function createProcessingPresetRepository(db) {
  const findByIdStmt = db.prepare(`SELECT ${PRESET_COLUMNS.join(', ')} FROM processing_presets WHERE id = ?`);
  const listStmt = db.prepare(`
    SELECT ${PRESET_COLUMNS.join(', ')}
    FROM processing_presets
    ORDER BY operation_type ASC, display_name COLLATE NOCASE ASC, id ASC
  `);
  const listByOperationStmt = db.prepare(`
    SELECT ${PRESET_COLUMNS.join(', ')}
    FROM processing_presets
    WHERE operation_type = ?
    ORDER BY display_name COLLATE NOCASE ASC, id ASC
  `);
  const insertStmt = db.prepare(`
    INSERT INTO processing_presets
      (operation_type, display_name, system_key, config_version, config_json, watermark_id, scale_map_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING ${PRESET_COLUMNS.join(', ')}
  `);
  const renameStmt = db.prepare(`
    UPDATE processing_presets
    SET display_name = ?, updated_at = datetime('now')
    WHERE id = ?
    RETURNING ${PRESET_COLUMNS.join(', ')}
  `);
  const replaceStmt = db.prepare(`
    UPDATE processing_presets
    SET config_json = ?, watermark_id = ?, scale_map_id = ?, updated_at = datetime('now')
    WHERE id = ?
    RETURNING ${PRESET_COLUMNS.join(', ')}
  `);
  const deleteStmt = db.prepare(`
    DELETE FROM processing_presets
    WHERE id = ?
    RETURNING ${PRESET_COLUMNS.join(', ')}
  `);
  const importPresets = db.transaction(({ operationType, presets }) => {
    const imported = [];
    for (const preset of presets) {
      let suffix = 0;
      while (true) {
        const displayName = suffix === 0 ? preset.displayName : `${preset.displayName} (${suffix})`;
        try {
          imported.push(insertStmt.get(
            operationType,
            displayName,
            null,
            preset.configVersion,
            preset.configJson,
            null,
            null,
          ));
          break;
        } catch (error) {
          // The database's NOCASE unique index is the authority for name
          // equality, including collisions with seeded/system presets and
          // earlier entries from this same bundle.
          if (error?.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
          suffix += 1;
        }
      }
    }
    return imported;
  });
  const getMetaStmt = db.prepare('SELECT value FROM app_meta WHERE key = ?');
  const setMetaStmt = db.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const findScaleMapBySystemKeyStmt = db.prepare(`
    SELECT ${SCALE_MAP_COLUMNS.join(', ')} FROM watermark_scale_maps WHERE system_key = ?
  `);
  const findPresetBySystemKeyStmt = db.prepare(`
    SELECT ${PRESET_COLUMNS.join(', ')} FROM processing_presets WHERE system_key = ?
  `);
  const updatePresetBySystemKeyStmt = db.prepare(`
    UPDATE processing_presets
    SET config_version = ?, config_json = ?,
        watermark_id = ?, scale_map_id = NULL, updated_at = datetime('now')
    WHERE system_key = ?
  `);
  const insertScaleMapStmt = db.prepare(`
    INSERT INTO watermark_scale_maps (display_name, system_key, definition_json)
    VALUES (?, ?, ?)
    RETURNING ${SCALE_MAP_COLUMNS.join(', ')}
  `);

  const seedReferenceData = db.transaction(({ markerKey, scaleMap, presets }) => {
    if (getMetaStmt.get(markerKey)) return false;

    let seededScaleMap = findScaleMapBySystemKeyStmt.get(scaleMap.systemKey);
    if (!seededScaleMap) {
      let displayName = scaleMap.displayName;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          seededScaleMap = insertScaleMapStmt.get(displayName, scaleMap.systemKey, scaleMap.definitionJson);
          break;
        } catch (error) {
          if (error?.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
          displayName = `${scaleMap.displayName} (CreatorCrate${attempt === 0 ? '' : ` ${attempt + 1}`})`;
        }
      }
      if (!seededScaleMap) throw new Error('Could not choose a collision-safe display name for the reference scale map.');
    }

    for (const preset of presets) {
      if (findPresetBySystemKeyStmt.get(preset.systemKey)) {
        updatePresetBySystemKeyStmt.run(
          preset.configVersion,
          preset.configJson,
          preset.watermarkId,
          preset.systemKey,
        );
        continue;
      }

      let displayName = preset.displayName;
      let seededPreset;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          seededPreset = insertStmt.get(
            preset.operationType,
            displayName,
            preset.systemKey,
            preset.configVersion,
            preset.configJson,
            preset.watermarkId,
            // Scale maps are singleton execution state, never preset bindings.
            null,
          );
          break;
        } catch (error) {
          if (error?.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
          displayName = `${preset.displayName} (CreatorCrate${attempt === 0 ? '' : ` ${attempt + 1}`})`;
        }
      }
      if (!seededPreset) throw new Error(`Could not choose a collision-safe display name for preset ${preset.systemKey}.`);
    }
    setMetaStmt.run(markerKey, '1');
    return true;
  });

  return {
    findById(id) { return findByIdStmt.get(id); },
    list(operationType) { return operationType === undefined ? listStmt.all() : listByOperationStmt.all(operationType); },
    create({ operationType, displayName, systemKey = null, configVersion, configJson, watermarkId = null, scaleMapId = null }) {
      return insertStmt.get(operationType, displayName, systemKey, configVersion, configJson, watermarkId, scaleMapId);
    },
    rename(id, displayName) { return renameStmt.get(displayName, id); },
    replace(id, { configJson, watermarkId, scaleMapId }) { return replaceStmt.get(configJson, watermarkId, scaleMapId, id); },
    delete(id) { return deleteStmt.get(id); },
    importPresets,
    seedReferenceData,
  };
}
