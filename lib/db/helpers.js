function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const statementCaches = new WeakMap();

function prepared(sqlite, sql) {
  let cache = statementCaches.get(sqlite);
  if (!cache) {
    cache = new Map();
    statementCaches.set(sqlite, cache);
  }
  if (!cache.has(sql)) cache.set(sql, sqlite.prepare(sql));
  return cache.get(sql);
}

function readMeta(sqlite, key, fallback = '') {
  const row = prepared(sqlite, 'SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function writeMeta(sqlite, key, value) {
  prepared(sqlite, `
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function readIdTable(sqlite, table) {
  const rows = prepared(sqlite, `SELECT id, body FROM ${table} ORDER BY id ASC`).all();
  return rows.map(row => parseJson(row.body, {}));
}

function writeIdTable(sqlite, table, items) {
  const tx = sqlite.transaction(list => {
    prepared(sqlite, `DELETE FROM ${table}`).run();
    const insert = prepared(sqlite, `INSERT INTO ${table} (id, body) VALUES (?, ?)`);
    for (const item of list) {
      insert.run(Number(item.id), JSON.stringify(item));
    }
  });
  tx(Array.isArray(items) ? items : []);
}

function upsertIdRow(sqlite, table, item) {
  if (!item || item.id === undefined || item.id === null) throw new Error(`Invalid ${table} row id`);
  prepared(sqlite, `
    INSERT INTO ${table} (id, body) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET body = excluded.body
  `).run(Number(item.id), JSON.stringify(item));
}

function deleteIdRow(sqlite, table, id) {
  return prepared(sqlite, `DELETE FROM ${table} WHERE id = ?`).run(Number(id));
}

function updateIdRows(sqlite, table, items) {
  const tx = sqlite.transaction(list => {
    const update = prepared(sqlite, `UPDATE ${table} SET body = ? WHERE id = ?`);
    for (const item of list) update.run(JSON.stringify(item), Number(item.id));
  });
  tx(Array.isArray(items) ? items : []);
}

function readSingleton(sqlite, table, fallback) {
  const row = prepared(sqlite, `SELECT body FROM ${table} WHERE id = 1`).get();
  return row ? parseJson(row.body, fallback) : fallback;
}

function writeSingleton(sqlite, table, value) {
  prepared(sqlite, `
    INSERT INTO ${table} (id, body) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET body = excluded.body
  `).run(JSON.stringify(value));
}

function readStringList(sqlite, table, column) {
  return prepared(sqlite, `SELECT ${column} FROM ${table} ORDER BY rowid ASC`).all().map(row => row[column]);
}

function writeStringList(sqlite, table, column, values) {
  const tx = sqlite.transaction(list => {
    prepared(sqlite, `DELETE FROM ${table}`).run();
    const insert = prepared(sqlite, `INSERT INTO ${table} (${column}) VALUES (?)`);
    for (const value of list) insert.run(String(value));
  });
  tx(Array.isArray(values) ? values : []);
}

function readIndexedList(sqlite, table) {
  return prepared(sqlite, `SELECT body FROM ${table} ORDER BY sort_index ASC`).all()
    .map(row => parseJson(row.body, {}));
}

function writeIndexedList(sqlite, table, kind, items) {
  const tx = sqlite.transaction(list => {
    prepared(sqlite, `DELETE FROM ${table} WHERE kind = ?`).run(kind);
    const insert = prepared(sqlite, `INSERT INTO ${table} (kind, sort_index, body) VALUES (?, ?, ?)`);
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
  upsertIdRow,
  deleteIdRow,
  updateIdRows,
  readSingleton,
  writeSingleton,
  readStringList,
  writeStringList,
  readIndexedList,
  writeIndexedList,
};
