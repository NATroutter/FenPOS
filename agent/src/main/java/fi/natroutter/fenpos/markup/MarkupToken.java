package fi.natroutter.fenpos.markup;

import java.util.List;

/**
 * One piece of a document as {@link MarkupTokenizer} read it.
 * <p>
 * Mirrors {@code Token} in {@code fenpos/lib/markup/tokenizer.ts}. A text run and an entity are
 * separate tokens so that every token's column is exact: an entity occupies more source characters
 * than it produces.
 */
sealed interface MarkupToken {

    /** The 1-based document line the token is on. */
    int line();

    /** The 1-based column within that line where the token starts. */
    int column();

    /**
     * Printable text.
     *
     * @param entity whether this is one decoded entity rather than a run of written characters
     */
    record Text(String text, boolean entity, int line, int column) implements MarkupToken {
    }

    /** An opening tag, its name as written and its attributes in the order written. */
    record Open(String name, List<RawAttribute> attributes, int line, int column) implements MarkupToken {
    }

    /** A closing tag, its name as written. */
    record Close(String name, int line, int column) implements MarkupToken {
    }

    /** The end of a line of the document. */
    record Break(int line, int column) implements MarkupToken {
    }
}
