import { Check, Circle } from "lucide-react"
import { cn } from "cn"
import { scorePassword, strengthLabels as labels } from "./passwordScore"

const barColor = ["", "bg-destructive", "bg-chart-4", "bg-chart-1", "bg-chart-3"]

export function PasswordStrength({ password }: { password: string }) {
  if (!password) return null
  const score = scorePassword(password)
  const longEnough = password.length >= 8

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1" aria-hidden>
        {labels.map((label, i) => (
          <div
            key={label}
            className={cn("h-1 flex-1 rounded-full bg-muted transition-colors", i < score && barColor[score])}
          />
        ))}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className={cn("flex items-center gap-1", longEnough && "text-foreground")}>
          {longEnough ? <Check className="size-3" /> : <Circle className="size-3" />}
          At least 8 characters
        </span>
        <span aria-live="polite">Strength: {labels[score - 1]}</span>
      </div>
    </div>
  )
}

export function PasswordMatch({ password, confirm }: { password: string; confirm: string }) {
  if (!password || !confirm) return null
  const matches = password === confirm
  return (
    <span aria-live="polite" className={cn("flex items-center gap-1 text-xs", matches ? "text-foreground" : "text-muted-foreground")}>
      {matches ? <Check className="size-3" /> : <Circle className="size-3" />}
      {matches ? "Passwords match" : "Passwords don't match yet"}
    </span>
  )
}
