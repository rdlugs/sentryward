import type { ApiKey } from "./api"

export function keyText(key: ApiKey) {
  return key.undecryptable ? "Unreadable" : key.last4 ? `••••${key.last4}` : "None"
}
