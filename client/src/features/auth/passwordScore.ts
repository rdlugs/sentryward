export const strengthLabels = ["Weak", "Fair", "Good", "Strong"] as const

// Advisory only: the one hard rule (8 characters) lives in the zod schemas and
// on the server. This nudges towards longer, mixed passwords without blocking.
export function scorePassword(password: string): 0 | 1 | 2 | 3 | 4 {
  if (!password) return 0
  let score = 1
  if (password.length >= 8) score++
  if (password.length >= 12) score++
  if (/[a-z]/.test(password) && /[A-Z]/.test(password) && /[^A-Za-z]/.test(password)) score++
  return Math.min(score, 4) as 1 | 2 | 3 | 4
}
