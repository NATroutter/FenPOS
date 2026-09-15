package fi.natroutter.fenpos.markup;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What one attribute accepts, and whether its tag can do without it.
 * <p>
 * Mirrors {@code AttributeSpec} in {@code fenpos/lib/markup/attributes.ts}; the tables built from it
 * on {@link Tag} mirror {@code TAGS} in {@code tags.ts}.
 */
public sealed interface AttributeSpec {

    /** Whether the tag means nothing without this attribute, so leaving it off is refused. */
    boolean required();

    /** A whole number within bounds. */
    record IntegerSpec(int min, int max, boolean required) implements AttributeSpec {
    }

    /** One of a fixed set, matched ignoring case and read back in the set's own spelling. */
    record EnumSpec(List<String> values, boolean required) implements AttributeSpec {
    }

    /** Free text of bounded length; written empty, it counts as left off. */
    record TextSpec(int maxLength, boolean required) implements AttributeSpec {
    }

    /** Exactly one character, counted in code points. */
    record CharSpec(boolean required) implements AttributeSpec {
    }

    static IntegerSpec integer(int min, int max) {
        return new IntegerSpec(min, max, false);
    }

    static EnumSpec oneOf(String... values) {
        return new EnumSpec(List.of(values), false);
    }

    static EnumSpec oneOf(Class<? extends Enum<?>> type) {
        return new EnumSpec(Arrays.stream(type.getEnumConstants()).map(Enum::name).toList(), false);
    }

    static TextSpec text(int maxLength) {
        return new TextSpec(maxLength, false);
    }

    static CharSpec character() {
        return new CharSpec(false);
    }

    /** The same spec, but one the tag cannot do without. */
    static AttributeSpec markRequired(AttributeSpec spec) {
        return switch (spec) {
            case IntegerSpec integer -> new IntegerSpec(integer.min(), integer.max(), true);
            case EnumSpec choice -> new EnumSpec(choice.values(), true);
            case TextSpec text -> new TextSpec(text.maxLength(), true);
            case CharSpec ignored -> new CharSpec(true);
        };
    }

    /**
     * Builds a tag's table from alternating names and specs, keeping the order written: required
     * attributes are checked in this order, as the panel checks its table in declaration order.
     */
    static Map<String, AttributeSpec> table(Object... namesAndSpecs) {
        Map<String, AttributeSpec> table = new LinkedHashMap<>();
        for (int i = 0; i < namesAndSpecs.length; i += 2) {
            table.put((String) namesAndSpecs[i], (AttributeSpec) namesAndSpecs[i + 1]);
        }
        return Collections.unmodifiableMap(table);
    }
}
