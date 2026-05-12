import { useState } from 'react';
import { Modal } from './Modal.js';

interface ConfirmDialogProps {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** When true, the confirm button gets the danger color. */
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Replacement for `window.confirm()` (FE-13, FE-22). Built on Modal so it
 * respects the design system tokens, focus management, and escape-to-close.
 * The confirm button is disabled while an async `onConfirm` is in flight,
 * so a double-click can't re-fire the destructive action.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element {
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async (): Promise<void> => {
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onCancel();
      }}
      title={title}
      {...(description !== undefined ? { description } : {})}
      footer={
        <>
          <button
            type="button"
            className="btn-ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={destructive ? 'btn-danger' : 'btn-primary'}
            onClick={() => {
              void handleConfirm();
            }}
            disabled={submitting}
          >
            {submitting ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-sm text-fg-muted">
        {description ? null : <p>This action cannot be undone.</p>}
      </div>
    </Modal>
  );
}
