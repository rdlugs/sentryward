// "1 finding", "2 findings"; pass the plural for irregular nouns. Here rather
// than in lib/ so the review engine stays free of app imports.
export function plural(count: number, word: string, words = `${word}s`): string {
  return `${count} ${count === 1 ? word : words}`;
}
