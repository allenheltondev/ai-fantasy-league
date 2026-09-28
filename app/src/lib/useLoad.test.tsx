import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLoad } from './useLoad';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useLoad', () => {
  it('loads, reloads, and reports errors', async () => {
    let n = 0;
    const { result } = renderHook(() =>
      useLoad(async () => {
        n++;
        if (n === 2) throw new Error('boom');
        return n;
      }, 'k')
    );
    await waitFor(() => expect(result.current.data).toBe(1));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.data).toBe(1);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toBe(3));
    expect(result.current.error).toBeNull();
  });

  it('ignores results that arrive after the key changed', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    const loads = { a: first, b: second, c: third };
    const { result, rerender } = renderHook(
      ({ k }: { k: 'a' | 'b' | 'c' }) => useLoad(() => loads[k].promise, k),
      {
        initialProps: { k: 'a' as 'a' | 'b' | 'c' }
      }
    );
    rerender({ k: 'b' });
    await act(async () => first.resolve('stale'));
    expect(result.current.data).toBeNull();
    rerender({ k: 'c' });
    await act(async () => second.reject(new Error('stale')));
    expect(result.current.error).toBeNull();
    await act(async () => third.resolve('fresh'));
    expect(result.current.data).toBe('fresh');
  });
});
