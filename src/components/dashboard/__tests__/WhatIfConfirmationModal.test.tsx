import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WhatIfConfirmationModal } from '../WhatIfConfirmationModal';

const BASE_PROPS = {
  open: true,
  confirmationMessage:
    'Sto leggendo: fermo macchina M02 dalle 14:00 alle 18:00. Confermi?',
  onConfirm: vi.fn(),
  onUseOpus: vi.fn(),
  onCancel: vi.fn(),
};

describe('WhatIfConfirmationModal', () => {
  it('renders confirmationMessage as paragraph', () => {
    render(<WhatIfConfirmationModal {...BASE_PROPS} />);
    expect(
      screen.getByText(BASE_PROPS.confirmationMessage),
    ).toBeInTheDocument();
  });

  it('"Conferma" click invokes onConfirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<WhatIfConfirmationModal {...BASE_PROPS} onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: /conferma e applica/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('"Riformula" click invokes onUseOpus', async () => {
    const user = userEvent.setup();
    const onUseOpus = vi.fn();
    render(<WhatIfConfirmationModal {...BASE_PROPS} onUseOpus={onUseOpus} />);
    await user.click(screen.getByRole('button', { name: /riformula con ai/i }));
    expect(onUseOpus).toHaveBeenCalledTimes(1);
  });

  it('"Annulla" click invokes onCancel', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<WhatIfConfirmationModal {...BASE_PROPS} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: /^annulla$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('when open=false, modal content is not visible', () => {
    render(<WhatIfConfirmationModal {...BASE_PROPS} open={false} />);
    expect(
      screen.queryByText(BASE_PROPS.confirmationMessage),
    ).not.toBeInTheDocument();
  });
});
