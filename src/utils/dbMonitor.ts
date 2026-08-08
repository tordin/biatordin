import sqlite3 from 'sqlite3';
import { biaEvents } from './events.js';

export function initDbMonitor() {
  const originalRun = sqlite3.Database.prototype.run;
  const originalGet = sqlite3.Database.prototype.get;
  const originalAll = sqlite3.Database.prototype.all;
  const originalExec = sqlite3.Database.prototype.exec;

  function emitDbEvent(method: string, sql: string, params: any[]) {
    biaEvents.emit('log', {
      timestamp: new Date().toISOString(),
      event: 'DB_QUERY',
      data: { method, sql, params }
    });
  }

  sqlite3.Database.prototype.run = function (sql: string, ...params: any[]) {
    // If the last argument is a function, it's a callback, we shouldn't emit it in params
    const args = Array.from(arguments).slice(1);
    const cbIndex = args.findIndex(arg => typeof arg === 'function');
    const queryParams = cbIndex >= 0 ? args.slice(0, cbIndex) : args;

    emitDbEvent('run', sql, queryParams);
    return originalRun.apply(this, [sql, ...params] as any);
  };

  sqlite3.Database.prototype.get = function (sql: string, ...params: any[]) {
    const args = Array.from(arguments).slice(1);
    const cbIndex = args.findIndex(arg => typeof arg === 'function');
    const queryParams = cbIndex >= 0 ? args.slice(0, cbIndex) : args;

    emitDbEvent('get', sql, queryParams);
    return originalGet.apply(this, [sql, ...params] as any);
  };

  sqlite3.Database.prototype.all = function (sql: string, ...params: any[]) {
    const args = Array.from(arguments).slice(1);
    const cbIndex = args.findIndex(arg => typeof arg === 'function');
    const queryParams = cbIndex >= 0 ? args.slice(0, cbIndex) : args;

    emitDbEvent('all', sql, queryParams);
    return originalAll.apply(this, [sql, ...params] as any);
  };

  sqlite3.Database.prototype.exec = function (sql: string, callback?: (err: Error | null) => void) {
    emitDbEvent('exec', sql, []);
    return originalExec.apply(this, [sql, callback] as any);
  };

  console.log('[DB_MONITOR] sqlite3 has been monkey-patched for real-time monitoring.');
}
