/**
 * The synthetic receipt both regression entry points use.
 *
 * One generator, two consumers (`run.mjs` and `integrity.test.ts`): when they
 * each kept their own copy, a change to either fixture meant the smoke runner
 * and the integrity check were no longer testing the same shape.
 *
 * The shape matters: it is long enough to trip every configured window, and its
 * tail carries the two signals the truncator must preserve (`ERROR:` and the
 * exit line).
 */
export function receipt(lines = 60): string {
  const row = (index: number): string => `./step-${index}.sh: running checks (${'ok '.repeat(30)})\n`
  const body = Array.from({ length: lines }, (_, index) => row(index)).join('')
  return `${body}ERROR: build failed at src/x.ts:12\nexit code 1\n`
}
