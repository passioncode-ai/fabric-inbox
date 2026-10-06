/**
 * What an archive or a discard did, with Undo (also ⌘Z / Ctrl+Z), and after a discard that taught a
 * new rule, the once-only notice "Future mail from X will go to Discarded" with Don't.
 */
export default function UndoToast({ text, onUndo, undoing, notice, onDont, onClose, undoKey }: {
  text: string;
  onUndo?: () => void;
  undoing?: boolean;
  notice?: string;
  onDont?: () => void;
  onClose: () => void;
  undoKey: string;
}) {
  return (
    <div className="fi-toast" role="status" aria-live="polite">
      <p>
        <span>{text}</span>
        {onUndo && <button type="button" className="fi-text-button" disabled={undoing} onClick={onUndo} title={`Undo (${undoKey})`}>{undoing ? "Undoing…" : "Undo"}</button>}
      </p>
      {notice && (
        <p className="fi-toast-notice">
          <span>{notice}</span>
          {onDont && <button type="button" className="fi-text-button" onClick={onDont}>Don't</button>}
        </p>
      )}
      <button type="button" className="fi-toast-close" aria-label="Dismiss" onClick={onClose}>×</button>
    </div>
  );
}
