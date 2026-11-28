import { Database } from 'bun:sqlite';
import { renameSync } from 'node:fs';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, received ${Bun.version}`);

const [path, operation] = Bun.argv.slice(2);
const db = new Database(path!);
try {
  switch (operation) {
    case 'moved':
      db.exec('CREATE TABLE entries(n INTEGER) STRICT');
      renameSync(path!, path! + '.moved');
      db.exec('INSERT INTO entries VALUES (1)');
      break;
    case 'datatype':
      db.exec('CREATE TABLE entries(n INTEGER) STRICT');
      db.exec("INSERT INTO entries VALUES ('synthetic')");
      break;
    case 'foreign-key':
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('CREATE TABLE parents(id INTEGER PRIMARY KEY)');
      db.exec('CREATE TABLE entries(parent INTEGER REFERENCES parents(id))');
      db.exec('INSERT INTO entries VALUES (1)');
      break;
    default:
      throw new Error('Unknown SQLite oracle operation');
  }
  console.log('null');
} catch (cause) {
  const error = cause as import('bun:sqlite').SQLiteError;
  console.log(JSON.stringify({ name: error.name, code: error.code, errno: error.errno, message: error.message }));
} finally {
  db.close();
}
