import type { ReactNode } from "react";

export const inputClass = "w-full px-4 py-2.5 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-primary-500";
export const buttonClass = "bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white px-4 py-2.5 rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2";
export const panelClass = "p-6 rounded-xl bg-[var(--color-card)] border border-[var(--color-border)]";

export function AccountForm({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="min-h-[80vh] flex items-center justify-center px-6 py-10">
    <section className={`w-full max-w-md ${panelClass}`}>
      <h1 className="text-2xl font-bold mb-2">{title}</h1>
      {description && <p className="text-[var(--color-muted)] mb-6">{description}</p>}
      {children}
    </section>
  </div>;
}
export function FormMessage({ message, error = false }: { message: string; error?: boolean }) {
  return message ? <p role={error ? "alert" : "status"} className={`text-sm ${error ? "text-red-500" : "text-[var(--color-muted)]"}`}>{message}</p> : null;
}
