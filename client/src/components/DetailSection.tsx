import type { ReactNode } from "react"

// The building blocks of the details sheets, so they all read alike.
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  )
}

// One label and value pair; the caller supplies the surrounding <dl> grid.
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}
