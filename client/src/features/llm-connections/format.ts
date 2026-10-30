import type { ApiKey } from "./api"

export function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : null
}

export function keyText(key: ApiKey) {
  return key.undecryptable ? "Unreadable" : key.last4 ? `••••${key.last4}` : "None"
}
