package fi.natroutter.fenpos.markup;

import java.util.Map;

/**
 * A tag's attributes after {@link AttributeReader} checked them: integers as {@link Integer},
 * everything else as {@link String}, each with the column its key was written at.
 * <p>
 * An attribute that was left off, or a text attribute written empty, has no entry.
 */
record Attributes(Map<String, Object> values, Map<String, Integer> columns) {

    boolean has(String name) {
        return values.containsKey(name);
    }

    int integer(String name, int fallback) {
        Object value = values.get(name);
        return value == null ? fallback : (Integer) value;
    }

    String string(String name) {
        return (String) values.get(name);
    }

    int column(String name) {
        return columns.get(name);
    }
}
