import { useEffect, useRef } from "react";
import { shortcutList, shortcutText } from "~/lib/mail-keys";
import { useT } from "~/lib/i18n";

/** The Keyboard shortcuts help (? in the mail list): every key the list answers to, as the platform spells it. */
export default function ShortcutsDialog({ open, mac, onClose }: { open: boolean; mac: boolean; onClose: () => void }) {
  const t = useT();
  const T = shortcutText(t);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (open && el && !el.open) el.showModal();
    if (!open && el?.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} className="fi-rules-dialog fi-shortcuts" aria-labelledby="fi-shortcuts-title" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <header>
        <h2 id="fi-shortcuts-title">{T.title}</h2>
        <button type="button" className="fi-icon-button" aria-label={T.close} onClick={onClose}>×</button>
      </header>
      {shortcutList(mac, t).map((group) => (
        <section key={group.title}>
          <h3>{group.title}</h3>
          <dl>
            {group.keys.map((k) => (
              <div key={k.does}>
                <dt>{k.keys.map((key, i) => <span key={key}>{i ? T.or : ""}<kbd>{key}</kbd></span>)}</dt>
                <dd>{k.does}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <p className="fi-hint">{T.footnote}</p>
    </dialog>
  );
}
