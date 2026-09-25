/** A tiny history router: enough for five pages, no dependency. */
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

export function navigate(to: string) {
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useLocation(): URL {
  const [url, setUrl] = useState(() => new URL(window.location.href));
  useEffect(() => {
    const on = () => setUrl(new URL(window.location.href));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return url;
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={onClick} className={className}>{children}</a>;
}

/** Read/write one query parameter as state. */
export function useQueryParam(name: string, fallback = ""): [string, (v: string) => void] {
  const url = useLocation();
  const value = url.searchParams.get(name) ?? fallback;
  const set = (v: string) => {
    const u = new URL(window.location.href);
    if (v) u.searchParams.set(name, v); else u.searchParams.delete(name);
    window.history.replaceState(null, "", u);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  return [value, set];
}
