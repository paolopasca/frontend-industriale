import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { DashboardHeader } from '../DashboardHeader';
import { PRINT_SNAPSHOT_KEY } from '@/lib/printSchedule';

/**
 * Wave 16.4 B1 — Esporta PDF race condition fix.
 *
 * Before the fix, window.open could run synchronously before
 * localStorage.setItem had committed in all browsers, leaving the
 * /print/$slug route reading stale or missing snapshot data.
 * The fix defers window.open by one macrotask (setTimeout(..., 0)).
 */

describe('DashboardHeader — Esporta PDF race', () => {
  let openMock: ReturnType<typeof vi.fn>;
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    openMock = vi.fn(() => ({}));
    vi.stubGlobal('open', openMock);
    setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setItemSpy.mockRestore();
    cleanup();
  });

  it('writes localStorage BEFORE window.open is invoked', () => {
    render(
      <DashboardHeader
        onReplan={() => {}}
        onAddData={() => {}}
        companySlug="test-co"
        companyName="Test Co"
        solverStatus="OPTIMAL"
      />,
    );

    const btn = screen.getByText('Esporta PDF');
    fireEvent.click(btn);

    // Storage write must already be done by the time the click handler returns.
    expect(setItemSpy).toHaveBeenCalled();
    const matchingCall = setItemSpy.mock.calls.find(
      ([key]: [string, string]) => typeof key === 'string' && key.includes(PRINT_SNAPSHOT_KEY) && key.includes('test-co'),
    );
    expect(matchingCall).toBeDefined();

    // window.open must NOT have been invoked yet (deferred to next tick).
    expect(openMock).not.toHaveBeenCalled();

    // After one tick the open call fires.
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock.mock.calls[0][0]).toBe('/print/test-co');

    // Ordering: setItem call index < window.open invocation order.
    const setItemOrder = setItemSpy.mock.invocationCallOrder[
      setItemSpy.mock.calls.indexOf(matchingCall!)
    ];
    const openOrder = openMock.mock.invocationCallOrder[0];
    expect(setItemOrder).toBeLessThan(openOrder);
  });
});
