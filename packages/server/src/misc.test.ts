import { describe, expect, it } from 'vitest';
import { loadLambdaConfig } from './config.js';
import { ApiError, ERROR_STATUS, internalError, isApiError } from './errors.js';
import { createLogger, parseLogLevel } from './log.js';

describe('ApiError', () => {
  it('carries status, fix, and details', () => {
    const error = new ApiError('ROUTE_NOT_FOUND', 'm', { fix: 'f', details: { a: 1 } });
    expect(error.status).toBe(404);
    expect(error.toBody()).toEqual({ code: 'ROUTE_NOT_FOUND', message: 'm', fix: 'f', details: { a: 1 } });
    expect(new ApiError('CONFLICT', 'm', { fix: 'f' }).toBody()).toEqual({
      code: 'CONFLICT',
      message: 'm',
      fix: 'f'
    });
    expect(isApiError(error)).toBe(true);
    expect(isApiError(new Error('x'))).toBe(false);
  });

  it('requires a fix', () => {
    expect(() => new ApiError('CONFLICT', 'm', { fix: '  ' })).toThrow(/non-empty fix/);
  });

  it('keeps the cause on internal errors', () => {
    const cause = new Error('db');
    expect(internalError(cause).cause).toBe(cause);
    expect(internalError().status).toBe(500);
  });

  it('maps every 4xx code to a client status', () => {
    for (const [code, status] of Object.entries(ERROR_STATUS)) {
      expect(status >= 400 && status < 600, code).toBe(true);
    }
  });
});

describe('logger', () => {
  it('writes JSON lines at or above the level with bindings', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', sink: (l) => lines.push(l), bindings: { app: 'x' } });
    log.debug('hidden');
    log.info('shown', { n: 1 });
    log.child({ requestId: 'r' }).warn('child');
    log.error('bad', { error: new Error('boom') });
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
      { level: 'info', message: 'shown', app: 'x', n: 1 },
      { level: 'warn', message: 'child', app: 'x', requestId: 'r' },
      { level: 'error', message: 'bad', app: 'x', error: expect.objectContaining({ message: 'boom' }) }
    ]);
  });

  it('parses levels', () => {
    expect(parseLogLevel('debug')).toBe('debug');
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel('error')).toBe('error');
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('loud')).toBe('info');
  });
});

describe('loadLambdaConfig', () => {
  it('reads the Lambda environment', () => {
    expect(
      loadLambdaConfig({
        TABLE_NAME: 't',
        USER_POOL_ID: 'p',
        USER_POOL_CLIENT_ID: 'c',
        ORIGIN_VERIFY_SECRET: 'o',
        LOG_LEVEL: 'debug'
      })
    ).toEqual({
      tableName: 't',
      userPoolId: 'p',
      userPoolClientId: 'c',
      eventBusName: 'default',
      logLevel: 'debug'
    });
  });

  it('names what is missing', () => {
    expect(() => loadLambdaConfig({ TABLE_NAME: 't' })).toThrow(
      /USER_POOL_ID, USER_POOL_CLIENT_ID, ORIGIN_VERIFY_SECRET/
    );
  });
});
