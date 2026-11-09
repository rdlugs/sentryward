// "1 day", "2 days"; pass the plural for irregular nouns ("repository", "repositories").
export function plural(count: number, noun: string, nouns = `${noun}s`) {
  return `${count} ${count === 1 ? noun : nouns}`
}
