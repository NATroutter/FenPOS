package fi.natroutter.fenpos.util;

import java.util.Arrays;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * Helpers for turning user-supplied text into enum constants.
 * <p>
 * Configuration and request fields name enum constants as strings. {@link Enum#valueOf}
 * throws for an unknown name, which forces every caller into a try/catch purely to report
 * a validation problem; these helpers return an {@link Optional} instead so callers can
 * treat an unknown value as data rather than as an exceptional condition.
 */
public final class Enums {

    private Enums() {
    }

    /**
     * Resolves a constant of {@code type} by name, ignoring case and surrounding whitespace.
     *
     * @param type the enum type to resolve against
     * @param name the candidate name; may be {@code null}
     * @param <E>  the enum type
     * @return the matching constant, or empty if {@code name} is {@code null}, blank, or unknown
     */
    public static <E extends Enum<E>> Optional<E> parse(Class<E> type, String name) {
        if (name == null || name.isBlank()) {
            return Optional.empty();
        }
        String normalized = name.strip();
        return Arrays.stream(type.getEnumConstants())
                .filter(constant -> constant.name().equalsIgnoreCase(normalized))
                .findFirst();
    }

    /**
     * Lists every constant name of {@code type}, for use in "must be one of" messages.
     *
     * @param type the enum type to describe
     * @return the constant names joined by ", " in declaration order
     */
    public static String names(Class<? extends Enum<?>> type) {
        return Arrays.stream(type.getEnumConstants())
                .map(Enum::name)
                .collect(Collectors.joining(", "));
    }
}
