import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export interface WhatIfConfirmationModalProps {
  open: boolean;
  confirmationMessage: string;
  patternId?: string;
  confidence?: number;
  onConfirm: () => void;
  onUseOpus: () => void;
  onCancel: () => void;
}

function confidenceBand(c: number): string {
  if (c >= 0.75) return 'alta';
  if (c >= 0.45) return 'media';
  return 'bassa';
}

export function WhatIfConfirmationModal({
  open,
  confirmationMessage,
  confidence,
  onConfirm,
  onUseOpus,
  onCancel,
}: WhatIfConfirmationModalProps) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel(); }}>
      <DialogContent data-testid="whatif-grayzone-modal">
        <DialogHeader>
          <DialogTitle>Conferma interpretazione</DialogTitle>
          <DialogDescription>
            {confirmationMessage}
          </DialogDescription>
        </DialogHeader>
        {confidence !== undefined && (
          <p className="text-xs text-muted-foreground">
            Confidenza: {confidenceBand(confidence)}
          </p>
        )}
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            className="text-muted-foreground"
            onClick={onCancel}
          >
            Annulla
          </Button>
          <Button
            variant="secondary"
            onClick={onUseOpus}
            title="Forza fallback a Opus per ri-interpretare"
          >
            Riformula con AI
          </Button>
          <Button
            className="bg-green-600 hover:bg-green-700 text-white"
            onClick={onConfirm}
          >
            Conferma e applica
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
