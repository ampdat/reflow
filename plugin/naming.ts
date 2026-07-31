/**
 * Turn a document's title into a name a vault can hold.
 *
 * `filenamify` does the part that is genuinely hard — the reserved characters of
 * three filesystems, Windows' device names (`con`, `aux`), control and format
 * codepoints, grapheme-safe truncation — and it is kept at its default 100
 * characters, which is comfortably inside every filesystem limit that matters
 * and still long enough that few paper titles are cut at all.
 *
 * What it cannot know is Obsidian. Two of its outputs are legal filenames and
 * still wrong here, so they are handled on either side of it (see below).
 *
 * The browser entry point specifically: `filenamify` proper also exports
 * `filenamifyPath`, which imports `node:path`. That would put a Node builtin in
 * a bundle the community directory reads — and break a mobile build — to reach a
 * function we never call.
 */
import filenamify from "filenamify/browser";

/**
 * Legal in a filename, hostile in a vault.
 *
 * `#` and `^` are how a wikilink addresses a heading and a block, and `[`/`]`
 * are the link syntax itself, so a note whose *name* contains one cannot be
 * linked to with `[[...]]` — Obsidian parses the name as the link's own
 * punctuation. Titles do carry them ("[Preprint] …", "C# in practice").
 */
const OBSIDIAN_HOSTILE = /[#^[\]]/g;

/**
 * A leading dot does not make a hidden file here so much as an invisible one:
 * Obsidian excludes dot-folders from the vault entirely, so a paper called
 * ".NET Internals" would convert successfully into a folder nobody can see from
 * inside the app. Stripped rather than replaced — a name should not open with
 * punctuation standing in for a dot nobody wanted.
 */
const LEADING_DOTS = /^\.+/;

/** Left behind by truncation and by the substitutions above. */
const TRAILING_JUNK = /[\s-]+$/;

/**
 * The name for one conversion's folder and its note.
 *
 * `fallback` is used when the title is missing or sanitizes away to nothing —
 * in practice the PDF's own filename, which is what the whole package used to
 * be named after.
 */
export function packageName(title: string, fallback: string): string {
  return clean(title) || clean(fallback) || "Untitled";
}

function clean(raw: string): string {
  // Collapse first: a title read off a page arrives with the line breaks of the
  // typesetting in it, and `filenamify` would replace each one, leaving a name
  // wearing its original column width as punctuation.
  const flat = raw.replace(OBSIDIAN_HOSTILE, " ").replace(/\s+/g, " ").trim();

  // "-" rather than the default "!", which is shell punctuation and reads as
  // shouting. A colon is where it lands most often ("Attention Is All You
  // Need: …"), and a dash is what a person would have typed there anyway.
  return filenamify(flat, { replacement: "-" })
    .replace(LEADING_DOTS, "")
    .replace(TRAILING_JUNK, "")
    .trim();
}
