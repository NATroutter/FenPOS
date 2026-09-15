package fi.natroutter.fenpos.markup;

import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Checks a tag's attributes against its table.
 * <p>
 * A port of {@code readAttributes} in {@code fenpos/lib/markup/attributes.ts}, messages included, so
 * a caller sees the same refusal wherever the markup is parsed. Attributes are checked one at a time
 * in the order written — unknown, then set twice, then the value — and required ones after all of
 * them. A bad value points at its own key's column; a missing one has no column and points at the tag.
 */
final class AttributeReader {

    /** A whole number as the panel accepts one: ASCII digits, optionally negative, nothing else. */
    private static final Pattern INTEGER = Pattern.compile("-?[0-9]+");

    private AttributeReader() {
    }

    /**
     * @param tag    the tag's name, for the message
     * @param raw    the attributes as the tokenizer read them
     * @param table  what the tag declares
     * @param line   the tag's line
     * @param column the tag's column, where a missing required attribute is reported
     */
    static Attributes read(String tag, List<RawAttribute> raw, Map<String, AttributeSpec> table, int line,
                           int column) throws MarkupException {
        Map<String, Object> values = new LinkedHashMap<>();
        Map<String, Integer> columns = new LinkedHashMap<>();
        // What was written, apart from what was kept: an empty text value is kept as nothing, and a
        // second one of the same name is still a second one.
        Set<String> seen = new HashSet<>();

        for (RawAttribute attribute : raw) {
            AttributeSpec spec = table.get(attribute.name());
            if (spec == null) {
                throw new MarkupException(MarkupError.UNKNOWN_ATTRIBUTE, line, attribute.column(), attribute.name(),
                        "<" + tag + "> has no attribute '" + attribute.name() + "'");
            }
            if (!seen.add(attribute.name())) {
                throw new MarkupException(MarkupError.INVALID_ATTRIBUTE, line, attribute.column(), attribute.name(),
                        "<" + tag + "> sets '" + attribute.name() + "' twice");
            }
            Object value = coerce(tag, attribute, spec, line);
            if (value != null) {
                values.put(attribute.name(), value);
                columns.put(attribute.name(), attribute.column());
            }
        }

        for (Map.Entry<String, AttributeSpec> entry : table.entrySet()) {
            if (entry.getValue().required() && !values.containsKey(entry.getKey())) {
                throw new MarkupException(MarkupError.INVALID_ATTRIBUTE, line, column, entry.getKey(),
                        "<" + tag + "> requires " + entry.getKey());
            }
        }

        return new Attributes(Collections.unmodifiableMap(values), Collections.unmodifiableMap(columns));
    }

    private static Object coerce(String tag, RawAttribute attribute, AttributeSpec spec, int line)
            throws MarkupException {
        String value = attribute.value();

        if (spec instanceof AttributeSpec.IntegerSpec integer) {
            String expected = "a whole number from " + integer.min() + " to " + integer.max();
            if (!INTEGER.matcher(value).matches()) {
                throw refuse(tag, attribute, line, expected);
            }
            int parsed;
            try {
                parsed = Integer.parseInt(value);
            } catch (NumberFormatException tooLarge) {
                throw refuse(tag, attribute, line, expected);
            }
            if (parsed < integer.min() || parsed > integer.max()) {
                throw refuse(tag, attribute, line, expected);
            }
            return parsed;
        }

        if (spec instanceof AttributeSpec.EnumSpec choice) {
            String wanted = value.toLowerCase(Locale.ROOT);
            for (String candidate : choice.values()) {
                if (candidate.toLowerCase(Locale.ROOT).equals(wanted)) {
                    return candidate;
                }
            }
            List<String> values = choice.values();
            String listed = String.join(", ", values.subList(0, values.size() - 1));
            throw refuse(tag, attribute, line, listed + " or " + values.getLast());
        }

        if (spec instanceof AttributeSpec.TextSpec text) {
            if (value.isEmpty()) {
                return null;
            }
            if (value.length() > text.maxLength()) {
                throw refuse(tag, attribute, line, "at most " + text.maxLength() + " characters");
            }
            return value;
        }

        if (value.codePointCount(0, value.length()) != 1) {
            throw refuse(tag, attribute, line, "a single character");
        }
        return value;
    }

    private static MarkupException refuse(String tag, RawAttribute attribute, int line, String expected) {
        return new MarkupException(MarkupError.INVALID_ATTRIBUTE, line, attribute.column(), attribute.name(),
                "<" + tag + "> " + attribute.name() + "=" + attribute.value() + " is not accepted; expected " + expected);
    }
}
