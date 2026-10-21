/**
 * The pane-input encoding — host independent, like `exit-sidecar.ts` and
 * `status-file.ts`.
 *
 * A pane input is one line: the text is typed into the pane and one Enter
 * keypress submits it. A newline inside the text ends that line in the
 * target, so the rest of the text arrives as separate input: a report that
 * spans lines reaches the parent as fragments, and a shell-shaped parent
 * pane runs the tail as commands.
 *
 * The encoding replaces the characters that end a line or a field with a
 * visible escape, so the text is typed as one input whatever the target
 * runs. A newline becomes `\n`, a carriage return `\r`, a tab `\t`, and any
 * other C0 control character or DEL `\xNN`. Everything else, a backslash
 * included, is left as it is: the encoding is not reversible, and it does
 * not claim to be. It buys one input, not the original bytes.
 */

/** The two characters a newline becomes. */
const NEWLINE_ESCAPE = "\\n";
/** The two characters a carriage return becomes. */
const CARRIAGE_RETURN_ESCAPE = "\\r";
/** The two characters a tab becomes. */
const TAB_ESCAPE = "\\t";

/**
 * Encode the text typed into a pane: one line, holding no line terminator
 * and no tab.
 */
export function encodePaneText(text: string): string {
  let encoded = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x0a) {
      encoded += NEWLINE_ESCAPE;
    } else if (code === 0x0d) {
      encoded += CARRIAGE_RETURN_ESCAPE;
    } else if (code === 0x09) {
      encoded += TAB_ESCAPE;
    } else if (code < 0x20 || code === 0x7f) {
      encoded += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      encoded += character;
    }
  }
  return encoded;
}
