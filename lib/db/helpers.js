function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readMeta(sqlite, key, fallback = '') {
  const row = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function writeMeta(sqlite, key, value) {
  sqlite.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function readIdTable(sqlite, table) {
  const rows = sqlite.prepare(`SELECT id, body FROM ${table} ORDER BY id ASC`).all();
  return rows.map(row => parseJson(row.body, {}));
}

function writeIdTable(sqlite, table, items) {
  const tx = sqlite.transaction(list => {
    sqlite.prepare(`DELETE FROM ${table}`).run();
    const insert = sqlite.prepare(`INSERT INTO ${table} (id, body) VALUES (?, ?)`);
    for (const item of list) {
      insert.run(Number(item.id), JSON.stringify(item));
    }
  });
  tx(Array.isArray(items) ? items : []);
}

function readSingleton(sqlite, table, fallback) {
  const row = sqlite.prepare(`SELECT body FROM ${table} WHERE id = 1`).get();
  return row ? parseJson(row.body, fallback) : fallback;
}

function writeSingleton(sqlite, table, value) {
  sqlite.prepare(`
    INSERT INTO ${table} (id, body) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET body = excluded.body
  `).run(JSON.stringify(value));
}

function readStringList(sqlite, table, column) {
  return sqlite.prepare(`SELECT ${column} FROM ${table} ORDER BY rowid ASC`).all().map(row => row[column]);
}

function writeStringList(sqlite, table, column, values) {
  const tx = sqlite.transaction(list => {
    sqlite.prepare(`DELETE FROM ${table}`).run();
    const insert = sqlite.prepare(`INSERT INTO ${table} (${column}) VALUES (?)`);
    for (const value of list) insert.run(String(value));
  });
  tx(Array.isArray(values) ? values : []);
}

function readIndexedList(sqlite, table) {
  return sqlite.prepare(`SELECT body FROM ${table} ORDER BY sort_index ASC`).all()
    .map(row => parseJson(row.body, {}));
}

function writeIndexedList(sqlite, table, kind, items) {
  const tx = sqlite.transaction(list => {
    sqlite.prepare(`DELETE FROM ${table} WHERE kind = ?`).run(kind);
    const insert = sqlite.prepare(`INSERT INTO ${table} (kind, sort_index, body) VALUES (?, ?, ?)`);
    list.forEach((item, index) => insert.run(kind, index, JSON.stringify(item)));
  });
  tx(Array.isArray(items) ? items : []);
}

module.exports = {
  parseJson,
  readMeta,
  writeMeta,
  readIdTable,
  writeIdTable,
  readSingleton,
  writeSingleton,
  readStringList,
  writeStringList,
  readIndexedList,
  writeIndexedList,
};
