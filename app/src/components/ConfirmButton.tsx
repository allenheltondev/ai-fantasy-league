import { useState, type ReactNode } from 'react';
import { Button, Modal, type ButtonVariant } from '@readysetcloud/ui';

/** A button that asks before it acts. */
export function ConfirmButton({
  label,
  title,
  message,
  confirmLabel,
  variant = 'secondary',
  disabled = false,
  onConfirm
}: {
  label: string;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} aria-label={title}>
          <div className="space-y-4 p-4">
            <h2 className="text-lg font-semibold">{title}</h2>
            <p>{message}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="error"
                onClick={() => {
                  setOpen(false);
                  onConfirm();
                }}
              >
                {confirmLabel}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
