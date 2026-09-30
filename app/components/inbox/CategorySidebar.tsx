import { Link } from "react-router";
import { FunnelSimpleIcon, SparkleIcon } from "@phosphor-icons/react";
import type { Category } from "~/services/categories";
import type { InboxAccount } from "./model";

interface Props {
  categories: Category[];
  accounts: InboxAccount[];
  active: string;
  onOpen: (id: string) => void;
}

/**
 * Categories in the sidebar (CAT-5): each opens its own view. A screened
 * category counts what arrived since it was last opened; a scope category
 * counts the unread mail of the inboxes it covers.
 */
export default function CategorySidebar({ categories, accounts, active, onOpen }: Props) {
  const count = (c: Category) => {
    if (c.kind === "screened") return c.stats.fresh;
    const ids = new Set(c.accountIds ?? []);
    return accounts.filter((a) => ids.has(a.id)).reduce((n, a) => n + (a.unread ?? 0), 0);
  };
  return (
    <>
      <div className="fi-section-label">
        CATEGORIES
        <Link to="/categories" aria-label="Create or change categories">+</Link>
      </div>
      {categories.length ? (
        <nav className="fi-category-list" aria-label="Categories">
          {categories.filter((c) => c.enabled).map((c) => {
            const n = count(c);
            return (
              <button key={c.id} type="button" className={"fi-category" + (active === c.id ? " is-active" : "")}
                aria-pressed={active === c.id} title={c.description || c.name} onClick={() => onOpen(c.id)}>
                {c.kind === "screened" ? <SparkleIcon size={14} aria-hidden="true" /> : <FunnelSimpleIcon size={14} aria-hidden="true" />}
                <span className="fi-category-name">{c.name}</span>
                {!!n && (
                  <span className="fi-unread-count" aria-label={c.kind === "screened" ? `${n} new in ${c.name}` : `${n} unread in ${c.name}`}>{n}</span>
                )}
              </button>
            );
          })}
        </nav>
      ) : (
        <Link className="fi-add-account fi-category-empty" to="/categories">
          <SparkleIcon size={15} aria-hidden="true" /> Create a category
        </Link>
      )}
    </>
  );
}
