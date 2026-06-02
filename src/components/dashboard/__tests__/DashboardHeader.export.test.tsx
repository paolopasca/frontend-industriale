import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DashboardHeader } from '../DashboardHeader';
import { PRINT_SNAPSHOT_KEY } from '@/lib/printSchedule';

/**
 * Wave 16.6 H-1 — Esporta PDF opens the print tab SYNCHRONOUSLY.
 *
 * The earlier Wave 16.4 fix deferred window.open via setTimeout(..., 0) to dodge
 * a localStorage write/open race. That deferral lost the user-gesture context, so
 * the browser popup-blocker killed the tab and every click surfaced a false
 * "popup bloccato" toast. The current handler (DashboardHeader.tsx) writes the
 * snapshot with a synchronous setSlugScoped and opens the tab synchronously in
 * the SAME click stack (a trusted user action — no popup block). The new tab only
 * reads the snapshot on a later tick, so there is no read/write race to defer for.
 * On a genuine block (open returns null) it rolls back the snapshot and shows an
 * error toast; on success it severs the opener (win.opener = null) for
 * reverse-tabnabbing safety.
 */

const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() },
}));

describe('DashboardHeader — Esporta PDF', () => {
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    toastError.mockReset();
    setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setItemSpy.mockRestore();
    cleanup();
  });

  function renderHeader() {
    render(
      <DashboardHeader
        onReplan={() => {}}
        onAddData={() => {}}
        companySlug="test-co"
        companyName="Test Co"
        solverStatus="OPTIMAL"
      />,
    );
  }

  it('writes the snapshot then opens the print tab synchronously in the same click', () => {
    const win: { opener: unknown } = { opener: {} };
    const openMock = vi.fn((_url?: string, _target?: string) => win as unknown as Window);
    vi.stubGlobal('open', openMock);

    renderHeader();
    fireEvent.click(screen.getByText('Esporta PDF'));

    // Snapshot written under the slug-scoped print key.
    const matchingCall = setItemSpy.mock.calls.find(
      ([key]: [string, string]) =>
        typeof key === 'string' && key.includes(PRINT_SNAPSHOT_KEY) && key.includes('test-co'),
    );
    expect(matchingCall).toBeDefined();

    // window.open fired SYNCHRONOUSLY (no tick) with the print route + _blank.
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock.mock.calls[0][0]).toBe('/print/test-co');
    expect(openMock.mock.calls[0][1]).toBe('_blank');

    // setItem ran BEFORE window.open (snapshot is committed first).
    const setItemOrder =
      setItemSpy.mock.invocationCallOrder[setItemSpy.mock.calls.indexOf(matchingCall!)];
    expect(setItemOrder).toBeLessThan(openMock.mock.invocationCallOrder[0]);

    // Opener severed for reverse-tabnabbing safety; no error toast on success.
    expect(win.opener).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('popup blocked (window.open returns null) → rolls back the snapshot and shows an error toast', () => {
    const openMock = vi.fn((_url?: string, _target?: string) => null as unknown as Window);
    vi.stubGlobal('open', openMock);

    renderHeader();
    fireEvent.click(screen.getByText('Esporta PDF'));

    // The handler tried to open the print tab (synchronously)...
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock.mock.calls[0][0]).toBe('/print/test-co');
    // ...and on the block surfaced a popup-blocked error toast.
    expect(toastError).toHaveBeenCalledTimes(1);
    // The just-written snapshot is rolled back so no stale print state lingers
    // (storage key shape: `${PREFIX}:${slug}:${key}` per src/lib/storage.ts).
    expect(localStorage.getItem(`daino:test-co:${PRINT_SNAPSHOT_KEY}`)).toBeNull();
  });
});
