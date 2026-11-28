// A module with hidden state: what a call returns depends on the calls before it.
let count = 0;

export function next(): number {
  count += 1;
  return count;
}
