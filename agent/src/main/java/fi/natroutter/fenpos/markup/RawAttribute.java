package fi.natroutter.fenpos.markup;

/**
 * An attribute as {@link MarkupTokenizer} read it, before it is checked against its tag.
 *
 * @param name   the key, lower-cased
 * @param value  the value with its entities decoded
 * @param column the 1-based column the key starts at
 */
record RawAttribute(String name, String value, int column) {
}
