/**
 * The agent's text, made safe to post as markdown from a job's account: what
 * it writes is untrusted (a pull request, a changelog can try to steer it).
 */

/** A code fence left open turns the rest of the text (a footer included) into
 * code: it's closed. */
export function closeFences(text: string): string {
  const fences = text
    .split("\n")
    .filter((line) => /^\s*(```|~~~)/.test(line)).length;
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text;
}

/**
 * The agent's text, as posted from the job's account: its @mentions notify no
 * one (a zero-width space after the `@`), it has no raw HTML, and its code
 * fences are closed. A suggestion is code, posted as is.
 */
export function quiet(text: string): string {
  // Raw HTML too: an unclosed `<!--` or `<details>` would hide the rest of the
  // text, an `<img>` load a URL. A zero-width space after the `<` makes it no
  // tag, and reads the same in code (`Array<string>`).
  const noHtml = text.replace(/<(?=[A-Za-z/!?])/g, "<\u200b");
  return closeFences(noHtml.replace(/(^|[^\w@])@(?=[\w-])/g, "$1@\u200b"));
}
